/** An image waiting in the composer, ready to send with `ipc.chat.send`. */
export interface DraftImage {
  key: string
  name: string
  mediaType: string
  /** Base64 file contents. */
  data: string
  /** A `data:` URL for the thumbnail. */
  url: string
}

const SUPPORTED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
/** Claude scales larger images down anyway; sending them only costs time. */
const MAX_EDGE = 2000
const MAX_BYTES = 5 * 1024 * 1024

/** The image files among dropped or pasted items. */
export function imageFiles(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []).filter((file) => file.type.startsWith("image/"))
}

/**
 * Reads an image for sending. Formats Claude doesn't take (HEIC, TIFF…) and
 * oversized images are redrawn as PNG or JPEG, at most `MAX_EDGE` px a side.
 */
export async function readImage(file: File): Promise<DraftImage> {
  const name = file.name || "Pasted image"
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`Couldn't read ${name} as an image`)
  }
  const fits = Math.max(bitmap.width, bitmap.height) <= MAX_EDGE && file.size <= MAX_BYTES
  const blob = SUPPORTED.has(file.type) && fits ? file : await redraw(bitmap, file.type)
  bitmap.close()
  if (blob.size > MAX_BYTES) throw new Error(`${name} is larger than 5 MB`)

  const url = await dataUrl(blob)
  return { key: crypto.randomUUID(), name, mediaType: blob.type, data: url.slice(url.indexOf(",") + 1), url }
}

async function redraw(bitmap: ImageBitmap, type: string): Promise<Blob> {
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  // Photos stay JPEG; screenshots and the rest keep sharp edges as PNG unless that's too big.
  if (type !== "image/jpeg") {
    const png = await canvas.convertToBlob({ type: "image/png" })
    if (png.size <= MAX_BYTES) return png
  }
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the image"))
    reader.readAsDataURL(blob)
  })
}
