/* Local demonstration geometry. A padded 3:4 artwork frame in a 3:4 stage.
   These percentages are neither physical dimensions nor a supplier schema. */
window.VynvoriGeometry = Object.freeze({
  valid(p) {
    if (!p) return true;
    const angle = (p.rotation ?? 0) * Math.PI / 180;
    if (![p.x, p.y, p.scale, angle].every(Number.isFinite) || p.scale < 12 || p.scale > 40) return false;
    const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
    const w = p.scale * (c + s * 4 / 3), h = p.scale * (c + s * 3 / 4);
    return p.x - w / 2 >= 30 && p.x + w / 2 <= 70 && p.y - h / 2 >= 20 && p.y + h / 2 <= 74;
  },
  style(p) {
    const finite = (v, fallback) => Number.isFinite(v) ? v : fallback;
    return `left:${finite(p.x, 50)}%;top:${finite(p.y, 46)}%;width:${finite(p.scale, 26)}%;transform:translate(-50%,-50%) rotate(${finite(p.rotation ?? 0, 0)}deg);`;
  }
});
