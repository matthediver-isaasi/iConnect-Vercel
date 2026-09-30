"use client"

import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Check, X } from "lucide-react"

import * as SharedSelect from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  formPickerCollisionPadding,
  formPickerDialogStyle,
  getFormPickerPlacement,
  readFormPickerViewport,
  subscribeFormPickerViewport,
} from "@/lib/formPickerGeometry"
import "./formPickerOverlay.css"

const FormSelectContext = React.createContext(null)
const DialogItemsContext = React.createContext(null)

function assignRef(ref, node) {
  if (typeof ref === "function") ref(node)
  else if (ref) ref.current = node
}

// Outside an iframe these exports are deliberately just the shared select.
function Select(props) {
  const embedded = typeof window !== "undefined" && window.parent !== window
  return embedded ? <EmbeddedSelect {...props} /> : <SharedSelect.Select {...props} />
}

function EmbeddedSelect({
  children, open: controlledOpen, defaultOpen = false, onOpenChange,
  value: controlledValue, defaultValue, onValueChange, disabled, ...props
}) {
  const [localOpen, setLocalOpen] = React.useState(defaultOpen)
  const [localValue, setLocalValue] = React.useState(defaultValue)
  const [geometry, setGeometry] = React.useState(null)
  const triggerRef = React.useRef(null)
  const open = controlledOpen === undefined ? localOpen : controlledOpen
  const value = controlledValue === undefined ? localValue : controlledValue
  const openRef = React.useRef(open)
  openRef.current = open
  const dialogLatched = React.useRef(false)
  const changeOpenRef = React.useRef(null)
  const dialogId = React.useId()

  const measure = React.useCallback((nextViewport, nextRect) => {
    const trigger = triggerRef.current
    if (!trigger) return
    const viewport = nextViewport || readFormPickerViewport(trigger.ownerDocument.defaultView)
    const rect = nextRect || trigger.getBoundingClientRect()
    if (openRef.current && !dialogLatched.current &&
        (rect.bottom <= viewport.top || rect.top >= viewport.bottom ||
         rect.right <= viewport.left || rect.left >= viewport.right)) {
      changeOpenRef.current?.(false)
      return
    }
    const placement = getFormPickerPlacement(rect, viewport)
    dialogLatched.current = dialogLatched.current || placement.dialog
    setGeometry({
      viewport,
      ...placement,
      dialog: dialogLatched.current,
    })
  }, [])

  const changeOpen = React.useCallback((nextOpen) => {
    if (nextOpen && disabled) return
    if (nextOpen) {
      if (!openRef.current) dialogLatched.current = false
      measure()
    }
    if (controlledOpen === undefined) setLocalOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }, [controlledOpen, disabled, measure, onOpenChange])
  changeOpenRef.current = changeOpen

  const changeValue = React.useCallback((nextValue) => {
    if (disabled) return
    if (controlledValue === undefined) setLocalValue(nextValue)
    if (nextValue !== value) onValueChange?.(nextValue)
  }, [controlledValue, disabled, onValueChange, value])

  React.useLayoutEffect(() => {
    if (!open) {
      dialogLatched.current = false
      return
    }
    if (!triggerRef.current) return
    measure()
    return subscribeFormPickerViewport(triggerRef.current, measure)
  }, [open, measure])

  const context = {
    open, openRef, value, disabled, triggerRef, geometry, dialogId,
    changeOpen, changeValue,
  }
  return (
    <FormSelectContext.Provider value={context}>
      <SharedSelect.Select
        {...props}
        disabled={disabled}
        value={value}
        onValueChange={changeValue}
        open={open && !!geometry && !geometry.dialog}
        onOpenChange={changeOpen}
      >
        {children}
      </SharedSelect.Select>
    </FormSelectContext.Provider>
  )
}

const SelectTrigger = React.forwardRef((props, ref) => {
  const context = React.useContext(FormSelectContext)
  const composedRef = React.useCallback((node) => {
    assignRef(ref, node)
    if (context) context.triggerRef.current = node
  }, [ref, context?.triggerRef])
  return (
    <SharedSelect.SelectTrigger
      {...props}
      ref={composedRef}
      {...(context?.geometry?.dialog ? {
        "aria-haspopup": "dialog",
        "aria-expanded": context.open,
        "aria-controls": context.open ? context.dialogId : undefined,
        "data-state": context.open ? "open" : "closed",
      } : {})}
    />
  )
})
SelectTrigger.displayName = "FormSelectTrigger"

const SelectValue = SharedSelect.SelectValue

function dialogLabel(trigger) {
  if (!trigger) return "Select an option"
  const labelledBy = trigger.getAttribute("aria-labelledby")
  const label = labelledBy?.split(/\s+/).map((id) =>
    trigger.ownerDocument.getElementById(id)?.textContent || ""
  ).join(" ").trim()
  return trigger.getAttribute("aria-label") || label ||
    Array.from(trigger.labels || []).map((item) => item.textContent).join(" ").trim() ||
    trigger.textContent?.trim() || "Select an option"
}

function DialogOptions({ children, context, contentRef, className, contentProps }) {
  const listRef = React.useRef(null)
  const searchRef = React.useRef({ text: "", time: 0 })
  const [activeValue, setActiveValue] = React.useState(context.value)
  const { viewport } = context.geometry
  const label = dialogLabel(context.triggerRef.current)
  const {
    onCloseAutoFocus, onEscapeKeyDown, onPointerDownOutside, onKeyDown,
  } = contentProps
  const enabledOptions = () => Array.from(
    listRef.current?.querySelectorAll('[role="option"]:not(:disabled)') || []
  )

  function focusOption(option) {
    option?.focus({ preventScroll: true })
    const list = listRef.current
    if (!option || !list) return
    // scrollIntoView also scrolls ancestor documents, including the Canvas host.
    // Only adjust this list's scroll position; focusing must not move the form.
    const optionRect = option.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    if (optionRect.top < listRect.top) list.scrollTop -= listRect.top - optionRect.top
    else if (optionRect.bottom > listRect.bottom) list.scrollTop += optionRect.bottom - listRect.bottom
  }

  function handleKeyDown(event) {
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    const options = enabledOptions()
    const index = options.indexOf(event.target)
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault()
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 :
        event.key === "ArrowDown" ? Math.min(index + 1, options.length - 1) :
          Math.max(index - 1, 0)
      focusOption(options[next])
    } else if (event.key === "Enter" || (event.key === " " &&
        (!searchRef.current.text || Date.now() - searchRef.current.time >= 1000))) {
      if (index >= 0) {
        event.preventDefault()
        options[index].click()
      }
    } else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      const now = Date.now()
      const previous = now - searchRef.current.time < 1000 ? searchRef.current.text : ""
      const text = previous + event.key.toLocaleLowerCase()
      searchRef.current = { text, time: now }
      const query = [...text].every((character) => character === text[0]) ? text[0] : text
      const ordered = [...options.slice(index + 1), ...options.slice(0, index + 1)]
      // Multi-character searches may continue matching the focused option.
      if (query.length > 1 && index >= 0) ordered.unshift(options[index])
      focusOption(ordered.find((option) =>
        (option.dataset.textValue || option.textContent || "").trim().toLocaleLowerCase().startsWith(query)
      ))
    }
  }

  return (
    <DialogPrimitive.Root open={context.open} onOpenChange={context.changeOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed z-[70] bg-black/50"
          style={{ left: viewport.left, top: viewport.top, width: viewport.width, height: viewport.height }}
        />
        <DialogPrimitive.Content
          ref={contentRef}
          id={context.dialogId}
          aria-describedby={undefined}
          className={cn("form-picker-content fixed z-[71] rounded-md border bg-popover text-popover-foreground shadow-lg outline-none", className)}
          style={formPickerDialogStyle(viewport)}
          onEscapeKeyDown={onEscapeKeyDown}
          onPointerDownOutside={onPointerDownOutside}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const options = enabledOptions()
            focusOption(options.find((option) => option.getAttribute("aria-selected") === "true") || options[0])
            if (!options.length) listRef.current?.focus({ preventScroll: true })
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event)
            if (event.defaultPrevented) return
            event.preventDefault()
            // A geometry change may be handing focus to the anchored content.
            if (!context.openRef.current) context.triggerRef.current?.focus({ preventScroll: true })
          }}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
            <DialogPrimitive.Title className="min-w-0 truncate text-sm font-medium">
              {label}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close className="shrink-0 rounded-sm p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Close options">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>
          <div
            ref={listRef}
            role="listbox"
            aria-label={label}
            tabIndex={-1}
            className="min-h-0 overflow-y-auto overscroll-contain p-1"
            style={{ WebkitOverflowScrolling: "touch" }}
            onKeyDown={handleKeyDown}
          >
            <DialogItemsContext.Provider value={{ ...context, activeValue, setActiveValue }}>
              {children}
            </DialogItemsContext.Provider>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

const SelectContent = React.forwardRef(({ children, className, style, ...props }, ref) => {
  const context = React.useContext(FormSelectContext)
  if (!context) {
    return <SharedSelect.SelectContent ref={ref} className={className} style={style} {...props}>{children}</SharedSelect.SelectContent>
  }
  if (!context.open || !context.geometry || context.geometry.dialog) {
    return (
      <>
        {/* Keep Radix's closed collection mounted, including ItemText's value
            portal and native form options, even while the dialog is open. */}
        <SharedSelect.SelectContent {...props}>{children}</SharedSelect.SelectContent>
        {context.open && context.geometry?.dialog && (
          <DialogOptions context={context} contentRef={ref} className={className} contentProps={props}>
            {children}
          </DialogOptions>
        )}
      </>
    )
  }
  const { viewport, side, maxHeight } = context.geometry
  const win = context.triggerRef.current.ownerDocument.defaultView
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        {...props}
        ref={ref}
        position="popper"
        side={side}
        sideOffset={4}
        align={props.align || "start"}
        collisionPadding={formPickerCollisionPadding(viewport, win)}
        className={cn("form-picker-content relative z-[60] rounded-md border bg-popover text-popover-foreground shadow-md", className)}
        style={{
          ...style,
          maxHeight,
          minWidth: 0,
          width: `min(var(--radix-select-trigger-width), ${Math.max(0, viewport.width - 16)}px)`,
          maxWidth: Math.max(0, viewport.width - 16),
        }}
        onCloseAutoFocus={(event) => {
          props.onCloseAutoFocus?.(event)
          if (context.openRef.current) event.preventDefault()
        }}
      >
        <SharedSelect.SelectScrollUpButton />
        <SelectPrimitive.Viewport className="w-full min-w-0 p-1" style={{ maxHeight, overscrollBehavior: "contain" }}>
          {children}
        </SelectPrimitive.Viewport>
        <SharedSelect.SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
})
SelectContent.displayName = "FormSelectContent"

const SelectItem = React.forwardRef(({ children, value, disabled, textValue, className, onClick, onFocus, ...props }, ref) => {
  const context = React.useContext(DialogItemsContext)
  if (!context) {
    return <SharedSelect.SelectItem {...props} ref={ref} value={value} disabled={disabled} textValue={textValue} className={className} onClick={onClick} onFocus={onFocus}>{children}</SharedSelect.SelectItem>
  }
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      role="option"
      tabIndex={!disabled && !context.disabled && context.activeValue === value ? 0 : -1}
      aria-selected={context.value === value}
      disabled={disabled || context.disabled}
      data-disabled={disabled || context.disabled ? "" : undefined}
      data-text-value={textValue}
      className={cn("relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-left text-sm outline-none focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50", className)}
      onFocus={(event) => {
        onFocus?.(event)
        context.setActiveValue(value)
      }}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || disabled || context.disabled) return
        context.changeValue(value)
        context.changeOpen(false)
      }}
    >
      <span className="min-w-0 break-words">{children}</span>
      {context.value === value && <Check aria-hidden="true" className="absolute right-2 h-4 w-4" />}
    </button>
  )
})
SelectItem.displayName = "FormSelectItem"

export { Select, SelectTrigger, SelectValue, SelectItem, SelectContent }