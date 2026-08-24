import type { ContentBounds, LayoutRect } from "./layout";

export type Camera = {
  x: number;
  y: number;
  scale: number;
};

export type CameraPoint = { x: number; y: number };
export type CameraViewport = { width: number; height: number };
export type CameraForm = "columns" | "rail" | "column" | "indented-rail";

export const MIN_ZOOM_SCALE = 0.25;
export const MAX_ZOOM_SCALE = 3;
export const FIT_MARGIN = 24;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function coordinate(value: CameraPoint | LayoutRect) {
  return { x: value.x, y: value.y };
}

/** Fit and center the complete tree inside the viewport. */
export function fitCamera(bounds: ContentBounds, viewport: CameraViewport, form: CameraForm = "columns", margin = FIT_MARGIN): Camera {
  void form;
  const width = Math.max(0, bounds.width);
  const height = Math.max(0, bounds.height);
  const viewportWidth = Math.max(0, viewport.width);
  const viewportHeight = Math.max(0, viewport.height);
  const horizontalMargin = Math.max(0, Math.min(margin, viewportWidth / 4));
  const verticalMargin = Math.max(0, Math.min(margin, viewportHeight / 4));
  const availableWidth = Math.max(0, viewportWidth - horizontalMargin * 2);
  const availableHeight = Math.max(0, viewportHeight - verticalMargin * 2);
  const widthScale = width > 0 && availableWidth > 0 ? availableWidth / width : 1;
  const heightScale = height > 0 && availableHeight > 0 ? availableHeight / height : 1;
  const scale = Math.min(widthScale, heightScale, 1);
  const centerX = bounds.x + width / 2;
  const centerY = bounds.y + height / 2;
  return {
    x: viewportWidth / 2 - centerX * scale,
    y: viewportHeight / 2 - centerY * scale,
    scale,
  };
}

/** Zoom around a screen point, preserving the world coordinate beneath that point. */
export function zoomAt(camera: Camera, point: CameraPoint, factor: number): Camera {
  const scale = clamp(camera.scale * (Number.isFinite(factor) ? factor : 1), MIN_ZOOM_SCALE, MAX_ZOOM_SCALE);
  const ratio = camera.scale ? scale / camera.scale : 1;
  return {
    scale,
    x: point.x - (point.x - camera.x) * ratio,
    y: point.y - (point.y - camera.y) * ratio,
  };
}

/** Translate only so the selected card keeps its screen position through relayout. */
export function pinCard(camera: Camera, before: CameraPoint | LayoutRect, after: CameraPoint | LayoutRect): Camera {
  const oldPosition = coordinate(before);
  const newPosition = coordinate(after);
  return {
    scale: camera.scale,
    x: camera.x + (oldPosition.x - newPosition.x) * camera.scale,
    y: camera.y + (oldPosition.y - newPosition.y) * camera.scale,
  };
}

/**
 * Translate only until every newly revealed child that is outside the viewport is
 * visible. The camera never changes scale, even when the children are wider/taller.
 */
export function revealChildren(
  camera: Camera,
  children: Array<CameraPoint | LayoutRect>,
  viewport: CameraViewport,
  margin = 16,
): Camera {
  if (!children.length) return { ...camera };
  let translateX = 0;
  let translateY = 0;
  const left = Math.min(...children.map((child) => child.x * camera.scale + camera.x));
  const right = Math.max(...children.map((child) => (child.x + ("w" in child ? child.w : 0)) * camera.scale + camera.x));
  const top = Math.min(...children.map((child) => child.y * camera.scale + camera.y));
  const bottom = Math.max(...children.map((child) => (child.y + ("h" in child ? child.h : 0)) * camera.scale + camera.y));
  if (left < margin) translateX = margin - left;
  else if (right > viewport.width - margin) translateX = viewport.width - margin - right;
  if (top < margin) translateY = margin - top;
  else if (bottom > viewport.height - margin) translateY = viewport.height - margin - bottom;
  return { x: camera.x + translateX, y: camera.y + translateY, scale: camera.scale };
}

export const fitToWidth = fitCamera;
export const zoomCameraAt = zoomAt;
