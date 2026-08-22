const PRECISION_FACTOR = 10000
export const DEFAULT_FPS = 25

const roundPrecision = value =>
  Math.round(value * PRECISION_FACTOR) / PRECISION_FACTOR

/*
 * Make sure that given time matches a frame in the video
 */
export const roundToFrame = (time, fps) => {
  const frameFactor = roundPrecision(1 / fps)
  const frameNumber = Math.round(time / frameFactor)
  return roundPrecision(frameNumber * frameFactor)
}

export const ceilToFrame = (time, fps) => {
  const frameFactor = roundPrecision(1 / fps)
  const frameNumber = Math.ceil(time / frameFactor)
  return (
    Math.ceil(frameNumber * frameFactor * PRECISION_FACTOR) / PRECISION_FACTOR
  )
}

export const floorToFrame = (time, fps) => {
  const frameFactor = roundPrecision(1 / fps)
  const frameNumber = Math.floor(time / frameFactor)
  return (
    Math.floor(frameNumber * frameFactor * PRECISION_FACTOR) / PRECISION_FACTOR
  )
}

/*
 * Turn a frame number into seconds depending on context.
 */
export const frameToSeconds = (nbFrames, production, shot) => {
  let fps = DEFAULT_FPS
  if (shot && shot.fps) fps = shot.fps
  if (production && production.fps) fps = production.fps
  return Math.round((nbFrames / fps) * 1000) / 1000
}

/*
 * Display time in a timecode format.
 */
export const formatTime = (rawTime, fps) => {
  if (!Number.isFinite(rawTime) || rawTime < 0) rawTime = 0

  const time = new Date(1000 * rawTime).toISOString()
  const milliseconds = parseInt(time.substring(20, 23))
  const frameDuration = roundPrecision(1 / fps)
  const frame = `${Math.round(milliseconds / (1000 * frameDuration))}`.padStart(
    2,
    '0'
  )
  try {
    return `${time.substring(11, 19)}:${frame}`
  } catch (err) {
    console.error(err)
    return '00:00:00:00'
  }
}

/*
 * Inverse of formatTime: parse a timecode string (HH:MM:SS:FF, HH:MM:SS or
 * MM:SS), a plain seconds string, or a raw seconds number into seconds.
 * Returns null when the value can't be parsed, so callers can tell "no
 * timecode" apart from a valid zero.
 */
export const parseTimeToSeconds = (value, fps) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!trimmed.includes(':')) {
    const seconds = Number(trimmed)
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
  }
  const parts = trimmed.split(':').map(Number)
  if (
    parts.length < 2 ||
    parts.length > 4 ||
    parts.some(number => !Number.isFinite(number))
  ) {
    return null
  }
  const frameDuration = Number.isFinite(fps) && fps > 0 ? 1 / fps : 0
  if (parts.length === 4) {
    const [hours, minutes, seconds, frames] = parts
    return Math.max(
      0,
      hours * 3600 + minutes * 60 + seconds + frames * frameDuration
    )
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts
    return Math.max(0, hours * 3600 + minutes * 60 + seconds)
  }
  const [minutes, seconds] = parts
  return Math.max(0, minutes * 60 + seconds)
}

/**
 * Get timecode from frame number.
 */
export const formatToTimecode = (frame, fps = DEFAULT_FPS) => {
  if (!frame || frame < 0) frame = 0
  const hours = Math.floor(frame / fps / 3600)
    .toString()
    .padStart(2, '0')
  const minutes = Math.floor((frame - hours * fps * 3600) / fps / 60)
    .toString()
    .padStart(2, '0')
  const seconds = Math.floor(
    (frame - hours * fps * 3600 - minutes * fps * 60) / fps
  )
    .toString()
    .padStart(2, '0')
  const frames = (frame % fps).toString().padStart(2, '0')
  return `${hours}:${minutes}:${seconds}:${frames}`
}

/*
 * Convert frame to a frame string.
 */
export const formatFrame = frame => {
  if (frame < 0) frame = 0
  return `${frame}`.padStart(3, '0')
}

/*
 * Get the production start frame of an entity (a shot numbered from
 * data.frame_in, e.g. 1001). Returns undefined when the entity carries no
 * usable value.
 */
export const getEntityFrameStart = entity => {
  const frameIn = parseInt(entity?.data?.frame_in)
  return frameIn > 0 ? frameIn : undefined
}
