import { useRef, useState } from "react";
import { X } from "lucide-react";
import { ImageAsset } from "./api";
import { Notice } from "./App";
const brushes: [number, string][] = [
  [16, "细"],
  [40, "中"],
  [80, "粗"],
];
// 遮罩编辑器：涂抹区域导出为透明，其余为白色不透明（与图片编辑接口一致）。
export function MaskEditor({
  source,
  onApply,
  onClose,
}: {
  source: ImageAsset;
  onApply: (mask: ImageAsset) => void;
  onClose: () => void;
}) {
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number }>();
  const [brush, setBrush] = useState(40);
  const [empty, setEmpty] = useState(true);
  const [error, setError] = useState("");
  const prepare = (img: HTMLImageElement) => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    if (
      !img.naturalWidth ||
      !img.naturalHeight ||
      img.naturalWidth * img.naturalHeight > 16_777_216
    ) {
      setError("参考图像素过大，请使用不超过1600万像素的图片编辑遮罩");
      return;
    }
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    setEmpty(true);
  };
  const position = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / (rect.width || canvas.width);
    return {
      x: (event.clientX - rect.left) * scale,
      y:
        ((event.clientY - rect.top) * canvas.height) /
        (rect.height || canvas.height),
      scale,
    };
  };
  const stroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const point = position(event);
    ctx.strokeStyle = "#b34334";
    ctx.lineWidth = brush * point.scale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    const from = last.current ?? point;
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    last.current = point;
    setEmpty(false);
  };
  const down = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    drawing.current = true;
    last.current = undefined;
    event.currentTarget.setPointerCapture(event.pointerId);
    stroke(event);
  };
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawing.current) stroke(event);
  };
  const up = () => {
    drawing.current = false;
    last.current = undefined;
  };
  const reset = () => {
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setEmpty(true);
  };
  const apply = () => {
    if (error) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const out = document.createElement("canvas");
    out.width = overlay.width;
    out.height = overlay.height;
    const ctx = out.getContext("2d");
    if (!ctx) {
      setError("当前设备不支持遮罩编辑");
      return;
    }
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    // 涂过的地方变成透明，告诉接口只重绘这些区域。
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(overlay, 0, 0);
    const data = out.toDataURL("image/png").split(",")[1];
    if (!data || data.length > 14 * 1024 * 1024) {
      setError("遮罩过大，请缩小参考图");
      return;
    }
    if (!data) {
      setError("生成遮罩失败，请重试");
      return;
    }
    onApply({ data, mime: "image/png" });
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet mask-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="编辑遮罩"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="sheet-grab" aria-hidden="true" />
        <div className="sheet-heading">
          <h2>遮罩重绘</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="取消编辑遮罩"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <p className="muted mask-tip">
          用画笔标出希望重绘的区域；具体保留效果取决于所选模型。
        </p>
        <div className="mask-canvas">
          <img
            alt="遮罩底图"
            src={`data:${source.mime};base64,${source.data}`}
            onLoad={(e) => prepare(e.currentTarget)}
          />
          <canvas
            ref={overlayRef}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          />
        </div>
        <div className="mask-brush" role="group" aria-label="画笔大小">
          {brushes.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`chip${brush === value ? " active" : ""}`}
              aria-pressed={brush === value}
              onClick={() => setBrush(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <Notice text={error} />
        <div className="mask-actions">
          <button type="button" className="secondary" onClick={reset}>
            重置
          </button>
          <button
            type="button"
            className="primary"
            disabled={empty || !!error}
            onClick={apply}
          >
            应用遮罩
          </button>
        </div>
      </div>
    </div>
  );
}
