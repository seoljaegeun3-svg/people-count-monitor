(() => {
  const api = window.monitor;
  const byId = id => document.getElementById(id);
  const openButton = byId('comparison-settings');
  const dialog = byId('comparison-dialog');
  const canvas = byId('comparison-canvas');
  const context = canvas.getContext('2d');
  const errorLabel = byId('comparison-error');
  const saveButton = byId('comparison-save');
  const status = byId('comparison-status');
  const regionKeys = ['x', 'y', 'width', 'height'];
  let image, region = null, drag = null, busy = false, opening = false;
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

  function publish(config) {
    status.textContent = config.configured ? config.mapping === 'unknown' ? '모든 통행 보관' : 'AI 비교 준비' : '설정 필요';
    status.dataset.configured = String(Boolean(config.configured));
    window.dispatchEvent(new CustomEvent('comparison-settings-changed', { detail: config }));
  }

  function updateRegionFields() {
    const value = region || { x: 0, y: 0, width: 1, height: 1 };
    for (const key of regionKeys) byId(`comparison-region-${key}`).value = String(Math.round(value[key] * 1000) / 10);
    byId('comparison-region-status').textContent = region ? '선택 영역과 출입선을 확인하세요. 화살표 방향이 입장입니다.' : '실제 카메라 영상 영역을 선택하세요.';
    saveButton.disabled = busy || !region || region.width < .05 || region.height < .05;
  }

  function draw() {
    if (!image) return;
    const width = canvas.width, height = canvas.height;
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    if (!region) return;
    const x = region.x * width, y = region.y * height, w = region.width * width, h = region.height * height;
    context.fillStyle = '#050912a6';
    context.fillRect(0, 0, width, y);
    context.fillRect(0, y + h, width, height - y - h);
    context.fillRect(0, y, x, h);
    context.fillRect(x + w, y, width - x - w, h);
    context.lineWidth = Math.max(2, width / 350);
    context.strokeStyle = '#64dfbb'; context.strokeRect(x, y, w, h);
    const vertical = byId('comparison-axis').value === 'vertical';
    const position = Number(byId('comparison-line').value) / 100;
    const direction = byId('comparison-invert').checked ? -1 : 1;
    const lineX = vertical ? x + w * position : x + w * .5;
    const lineY = vertical ? y + h * .5 : y + h * position;
    context.strokeStyle = '#ffb341'; context.beginPath();
    context.moveTo(vertical ? lineX : x, vertical ? y : lineY);
    context.lineTo(vertical ? lineX : x + w, vertical ? y + h : lineY); context.stroke();
    const size = Math.max(12, Math.min(w, h) * .1);
    const startX = lineX - (vertical ? size * direction : 0), startY = lineY - (vertical ? 0 : size * direction);
    const endX = lineX + (vertical ? size * direction : 0), endY = lineY + (vertical ? 0 : size * direction);
    context.beginPath(); context.moveTo(startX, startY); context.lineTo(endX, endY);
    context.moveTo(endX - (vertical ? size * .5 * direction : size * .5), endY - (vertical ? size * .5 : size * .5 * direction));
    context.lineTo(endX, endY);
    context.lineTo(endX - (vertical ? size * .5 * direction : -size * .5), endY + (vertical ? size * .5 : -size * .5 * direction)); context.stroke();
  }

  function setRegion(next) { region = next; updateRegionFields(); draw(); }
  function point(event) {
    const bounds = canvas.getBoundingClientRect();
    return { x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1), y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1) };
  }
  canvas.addEventListener('pointerdown', event => {
    if (busy || event.button !== 0) return;
    drag = point(event); canvas.setPointerCapture(event.pointerId); event.preventDefault();
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    const current = point(event), x = Math.min(drag.x, current.x), y = Math.min(drag.y, current.y);
    setRegion({ x, y, width: Math.abs(current.x - drag.x), height: Math.abs(current.y - drag.y) });
  });
  function endDrag(event) {
    if (!drag) return;
    drag = null;
    if (!region || region.width < .05 || region.height < .05) {
      setRegion(null); errorLabel.textContent = '영상 영역의 너비와 높이는 각각 전체 화면의 5% 이상 선택하세요.';
    } else errorLabel.textContent = '';
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  byId('comparison-region-reset').addEventListener('click', () => {
    errorLabel.textContent = ''; setRegion({ x: 0, y: 0, width: 1, height: 1 });
  });
  for (const key of regionKeys) byId(`comparison-region-${key}`).addEventListener('input', () => {
    const next = Object.fromEntries(regionKeys.map(name => [name, Number(byId(`comparison-region-${name}`).value) / 100]));
    if (Object.values(next).some(value => !Number.isFinite(value))) return;
    next.x = clamp(next.x, 0, .95); next.y = clamp(next.y, 0, .95);
    next.width = clamp(next.width, .05, 1 - next.x); next.height = clamp(next.height, .05, 1 - next.y);
    setRegion(next); errorLabel.textContent = '';
  });
  for (const id of ['comparison-axis', 'comparison-line', 'comparison-invert']) byId(id).addEventListener('input', () => {
    byId('comparison-line-value').textContent = `${byId('comparison-line').value}%`; draw();
  });
  byId('comparison-confidence').addEventListener('input', () => {
    byId('comparison-confidence-value').textContent = `${byId('comparison-confidence').value}%`;
  });

  function close() { if (!busy) dialog.close(); }
  byId('comparison-cancel').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    drag = null;
    document.dispatchEvent(new CustomEvent('comparison-dialog', { detail: { open: false } }));
  });
  async function open() {
    if (busy || opening || dialog.open) return;
    opening = true;
    openButton.disabled = true;
    try {
      // Capture before hiding native camera views for the modal.
      const [config, preview] = await Promise.all([api.comparisonSettings(), api.comparisonPreview()]);
      if (!preview.image?.startsWith('data:image/')) throw new Error('카메라 화면을 불러오지 못했습니다. 카메라를 연 뒤 다시 시도하세요.');
      const nextImage = new Image(); nextImage.src = preview.image; await nextImage.decode(); image = nextImage;
      canvas.width = preview.width; canvas.height = preview.height;
      byId('comparison-axis').value = config.line?.axis || 'vertical';
      byId('comparison-line').value = Math.round((config.line?.position ?? .5) * 100);
      byId('comparison-line-value').textContent = `${byId('comparison-line').value}%`;
      byId('comparison-invert').checked = Boolean(config.line?.invert);
      byId('comparison-mapping').value = config.mapping || 'unknown';
      byId('comparison-sensitivity').value = config.sensitivity || 'normal';
      byId('comparison-confidence').value = Math.round((config.confidence ?? .45) * 100);
      byId('comparison-confidence-value').textContent = `${byId('comparison-confidence').value}%`;
      errorLabel.textContent = ''; setRegion(config.configured ? { ...config.region } : null);
      dialog.showModal();
      document.dispatchEvent(new CustomEvent('comparison-dialog', { detail: { open: true } }));
    } catch (error) { toast(error.message); }
    finally { opening = false; openButton.disabled = false; }
  }
  openButton.addEventListener('click', open);
  window.addEventListener('open-comparison-settings', open);
  byId('comparison-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !region || region.width < .05 || region.height < .05) return;
    busy = true; updateRegionFields(); errorLabel.textContent = '';
    try {
      const saved = await api.comparisonSave({
        configured: true, region: { ...region },
        sensitivity: byId('comparison-sensitivity').value,
        line: { axis: byId('comparison-axis').value, position: Number(byId('comparison-line').value) / 100, invert: byId('comparison-invert').checked },
        mapping: byId('comparison-mapping').value,
        confidence: Number(byId('comparison-confidence').value) / 100
      });
      publish(saved); dialog.close(); toast('비교 영역과 출입선을 저장했습니다. 자동 녹화를 켜서 사용하세요.');
    } catch (error) { errorLabel.textContent = error.message; }
    finally { busy = false; updateRegionFields(); }
  });
  api.comparisonSettings().then(publish).catch(error => { status.textContent = '설정 불러오기 실패'; status.title = error.message; });
})();
