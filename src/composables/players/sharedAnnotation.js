/*
 * Composable for the shared-playlist annotation overlay.
 *
 * Owns the fabric canvas lifecycle for the guest / read-only overlay
 * view: canvas creation and disposal, pencil settings (color, width),
 * drawing and shape tool modes, local undo stack, and the additions
 * diff needed by `update_preview_file_annotations`. Does not handle
 * the full annotation feature set (that lives in useAnnotation).
 */
import { ref, shallowRef } from 'vue'

import { CURSOR_PENCIL } from '@/composables/players/annotationCursor'
import {
  DEFAULT_PENCIL_COLOR,
  DEFAULT_PENCIL_WIDTH,
  PENCIL_WIDTHS,
  SHAPE_STROKE_WIDTH,
  applyPencilColor,
  applyPencilWidth,
  attachMousePressureSimulation,
  attachShapeDrawing,
  createAnnotationCanvas,
  normalizeSerializedAnnotation,
  pushAddition,
  removeAddition,
  setObjectData
} from '@/lib/players/annotation'

/**
 * Composable that owns a `fabric.Canvas` configured exactly like the
 * studio-side annotation tool (PSBrush, same pencil width buckets, same
 * serialisation). Tracks user-drawn strokes as `additions` so the caller
 * can ship a diff matching `update_preview_file_annotations`.
 */
export const useSharedAnnotationCanvas = () => {
  const isDrawing = ref(false)
  const currentTool = ref('pen')
  const pencilColor = ref(DEFAULT_PENCIL_COLOR)
  const pencilWidth = ref(DEFAULT_PENCIL_WIDTH)
  const localStack = shallowRef([])
  const additionsRef = shallowRef([])
  // Diffs against objects that already exist server-side (loaded via
  // registerOwnObject, not drawn this session): moved/resized -> updates,
  // deleted -> deletions. Kept separate from additionsRef/localStack, which
  // track brand new, not-yet-saved strokes.
  const updatesRef = shallowRef([])
  const deletionsRef = shallowRef([])
  const hasOwnSelection = ref(false)

  let fabricCanvas = null
  let onPathCreated = null
  let onObjectModified = null
  let onSelectionChanged = null
  let onSelectionCleared = null
  let detachMousePressure = null
  let detachShapeDrawing = null
  let currentTime = 0
  let currentFrame = 0
  let lastAnnotationW = 0
  let lastAnnotationH = 0
  let userId = null
  // id -> { time }, for objects loaded from the server that this guest
  // authored (see registerOwnObject) and may therefore move, resize or
  // delete.
  const ownObjects = new Map()

  // Merge a serialized object into the entry at `time` within `list`,
  // replacing any prior entry for the same object id. Mirrors pushAddition's
  // one-entry-per-time shape but for already-serialized data (updates).
  const upsertObjectAt = (list, time, object) => {
    const existing = list.find(entry => entry.time === time)
    if (existing) {
      const others = existing.drawing.objects.filter(o => o.id !== object.id)
      existing.drawing.objects = [...others, object]
      return [...list]
    }
    return [...list, { time, drawing: { objects: [object] } }]
  }

  const pushUpdateForObject = target => {
    const meta = ownObjects.get(target.id)
    if (!meta) return
    const raw = target.serialize ? target.serialize() : target.toJSON()
    const normalized = normalizeSerializedAnnotation(target, raw)
    normalized.id = target.id
    updatesRef.value = upsertObjectAt(updatesRef.value, meta.time, normalized)
  }

  const refreshOwnSelectionFlag = () => {
    if (!fabricCanvas) {
      hasOwnSelection.value = false
      return
    }
    hasOwnSelection.value = fabricCanvas
      .getActiveObjects()
      .some(o => ownObjects.has(o.id))
  }

  // Called by the overlay after building an existing (server-loaded)
  // object as editable — marks it as this guest's own so object:modified
  // and deleteOwnSelection know it's theirs to change, and stamps the
  // reference frame onto it so a later move/resize normalizes correctly.
  const registerOwnObject = (shape, time, canvasWidth, canvasHeight) => {
    if (!shape?.id) return
    ownObjects.set(shape.id, { time })
    if (!shape.canvasWidth) shape.set('canvasWidth', canvasWidth)
    if (!shape.canvasHeight) shape.set('canvasHeight', canvasHeight)
  }

  const deleteOwnSelection = () => {
    if (!fabricCanvas) return
    const active = fabricCanvas
      .getActiveObjects()
      .filter(o => ownObjects.has(o.id))
    if (!active.length) return
    fabricCanvas.discardActiveObject()
    active.forEach(obj => {
      const meta = ownObjects.get(obj.id)
      fabricCanvas.remove(obj)
      ownObjects.delete(obj.id)
      // A pending (unsaved) move of an object we're now deleting is moot.
      updatesRef.value = updatesRef.value
        .map(entry => ({
          ...entry,
          drawing: {
            objects: entry.drawing.objects.filter(o => o.id !== obj.id)
          }
        }))
        .filter(entry => entry.drawing.objects.length > 0)
      const existing = deletionsRef.value.find(d => d.time === meta.time)
      if (existing) {
        existing.objects = [...existing.objects, obj.id]
        deletionsRef.value = [...deletionsRef.value]
      } else {
        deletionsRef.value = [
          ...deletionsRef.value,
          { time: meta.time, objects: [obj.id] }
        ]
      }
    })
    fabricCanvas.requestRenderAll()
    refreshOwnSelectionFlag()
  }

  const setup = (canvasEl, { width = 1, height = 1 } = {}) => {
    fabricCanvas = createAnnotationCanvas(canvasEl)
    fabricCanvas.setDimensions({ width, height })
    applyPencilColor(fabricCanvas, pencilColor.value)
    applyPencilWidth(fabricCanvas, pencilWidth.value)

    onObjectModified = ({ target }) => {
      if (!target?.id) return
      pushUpdateForObject(target)
    }
    fabricCanvas.on('object:modified', onObjectModified)
    onSelectionChanged = refreshOwnSelectionFlag
    onSelectionCleared = refreshOwnSelectionFlag
    fabricCanvas.on('selection:created', onSelectionChanged)
    fabricCanvas.on('selection:updated', onSelectionChanged)
    fabricCanvas.on('selection:cleared', onSelectionCleared)

    onPathCreated = ({ path }) => {
      if (!path) return
      setObjectData(path, fabricCanvas, userId)
      path.set('selectable', false)
      path.set('evented', false)
      pushAddition(additionsRef.value, {
        time: currentTime,
        frame: currentFrame,
        canvasWidth: lastAnnotationW || fabricCanvas.width,
        canvasHeight: lastAnnotationH || fabricCanvas.height,
        object: path
      })
      // Trigger reactivity for the shallowRef
      additionsRef.value = [...additionsRef.value]
      localStack.value = [...localStack.value, path]
      fabricCanvas.requestRenderAll()
    }
    fabricCanvas.on('path:created', onPathCreated)
    detachMousePressure = attachMousePressureSimulation(fabricCanvas)
    detachShapeDrawing = attachShapeDrawing(fabricCanvas, {
      getTool: () => (isDrawing.value ? currentTool.value : null),
      getColor: () => pencilColor.value,
      getWidth: () => SHAPE_STROKE_WIDTH,
      onShapeAdded: shape => {
        setObjectData(shape, fabricCanvas, userId)
        shape.set('selectable', false)
        shape.set('evented', false)
        pushAddition(additionsRef.value, {
          time: currentTime,
          frame: currentFrame,
          canvasWidth: lastAnnotationW || fabricCanvas.width,
          canvasHeight: lastAnnotationH || fabricCanvas.height,
          object: shape
        })
        additionsRef.value = [...additionsRef.value]
        localStack.value = [...localStack.value, shape]
      }
    })
    return fabricCanvas
  }

  const applyToolToCanvas = () => {
    if (!fabricCanvas) return
    const penActive = isDrawing.value && currentTool.value === 'pen'
    fabricCanvas.isDrawingMode = penActive
    fabricCanvas.skipTargetFind = !isDrawing.value
    // Cursor parity with the studio annotation tool: pencil while drawing,
    // crosshair for the shape tools, default otherwise.
    const cursor = !isDrawing.value
      ? 'default'
      : currentTool.value === 'pen'
        ? CURSOR_PENCIL
        : 'crosshair'
    fabricCanvas.freeDrawingCursor = cursor
    fabricCanvas.defaultCursor = cursor
    fabricCanvas.hoverCursor = cursor
  }

  const setDrawingMode = enabled => {
    isDrawing.value = !!enabled
    applyToolToCanvas()
  }

  const setTool = tool => {
    currentTool.value = tool
    applyToolToCanvas()
  }

  const setColor = color => {
    pencilColor.value = color
    applyPencilColor(fabricCanvas, color)
  }

  const setWidth = width => {
    pencilWidth.value = width
    applyPencilWidth(fabricCanvas, width)
  }

  const setUserId = id => {
    userId = id
  }

  const setTime = (time, frame) => {
    currentTime = time
    currentFrame = frame
  }

  const setCanvasSize = (width, height) => {
    if (!fabricCanvas) return
    fabricCanvas.setDimensions({ width, height })
  }

  const setAnnotationDimensions = (width, height) => {
    lastAnnotationW = width
    lastAnnotationH = height
  }

  const undo = () => {
    if (!fabricCanvas || localStack.value.length === 0) return
    const next = [...localStack.value]
    const last = next.pop()
    fabricCanvas.remove(last)
    localStack.value = next
    additionsRef.value = removeAddition(additionsRef.value, last.id)
  }

  const clearLocal = () => {
    if (!fabricCanvas) return
    localStack.value.forEach(o => fabricCanvas.remove(o))
    localStack.value = []
    additionsRef.value = []
    fabricCanvas.requestRenderAll()
  }

  const hasChanges = () =>
    additionsRef.value.length > 0 ||
    updatesRef.value.length > 0 ||
    deletionsRef.value.length > 0

  const getDiff = () => ({
    additions: additionsRef.value.map(a => ({ ...a })),
    updates: updatesRef.value.map(u => ({ ...u })),
    deletions: deletionsRef.value.map(d => ({ ...d }))
  })

  // Drop pending updates/deletions once they've been persisted. Unlike
  // clearLocal (which also removes not-yet-saved strokes from the canvas),
  // the edited/deleted objects here are already in their final on-canvas
  // state — only the pending-diff bookkeeping needs clearing.
  const clearSavedDiff = () => {
    updatesRef.value = []
    deletionsRef.value = []
  }

  const reset = () => {
    if (!fabricCanvas) return
    fabricCanvas.clear()
    localStack.value = []
    additionsRef.value = []
    ownObjects.clear()
    hasOwnSelection.value = false
  }

  // Re-adopt unsaved additions captured before a reset (resize, frame
  // step): the serialized entries are canvas-size independent, only the
  // live object list needs the rebuilt instances so undo keeps working.
  const restoreUnsaved = (entries, objects) => {
    additionsRef.value = entries
    localStack.value = objects
  }

  const dispose = () => {
    if (fabricCanvas && onPathCreated) {
      fabricCanvas.off('path:created', onPathCreated)
    }
    if (fabricCanvas && onObjectModified) {
      fabricCanvas.off('object:modified', onObjectModified)
    }
    if (fabricCanvas && onSelectionChanged) {
      fabricCanvas.off('selection:created', onSelectionChanged)
      fabricCanvas.off('selection:updated', onSelectionChanged)
    }
    if (fabricCanvas && onSelectionCleared) {
      fabricCanvas.off('selection:cleared', onSelectionCleared)
    }
    detachMousePressure?.()
    detachMousePressure = null
    detachShapeDrawing?.()
    detachShapeDrawing = null
    fabricCanvas?.dispose()
    fabricCanvas = null
    onPathCreated = null
    onObjectModified = null
    onSelectionChanged = null
    onSelectionCleared = null
    ownObjects.clear()
  }

  const getCanvas = () => fabricCanvas

  return {
    PENCIL_WIDTHS,
    additions: additionsRef,
    clearLocal,
    clearSavedDiff,
    currentTool,
    deleteOwnSelection,
    dispose,
    getDiff,
    getCanvas,
    hasChanges,
    hasOwnSelection,
    isDrawing,
    localStack,
    pencilColor,
    pencilWidth,
    registerOwnObject,
    reset,
    restoreUnsaved,
    setAnnotationDimensions,
    setCanvasSize,
    setColor,
    setDrawingMode,
    setTime,
    setTool,
    setUserId,
    setWidth,
    setup,
    undo
  }
}
