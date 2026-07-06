import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { cx } from '../admin/cx'
import { limitByUnicode } from '@/utils/string'
import styles from './TagInput.module.css'

/** Separators that trigger multi-value paste splitting (comma incl. full-width, tab, newline). */
const PASTE_SPLIT = /[\n\r\t,，]+/

const CloseIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
)

export interface TagInputProps {
  label?: string
  hint?: string
  invalid?: boolean
  value: string[]
  onChange: (tags: string[]) => void
  maxTags?: number
  maxTagLength?: number
  placeholder?: string
  /** placeholder shown once `maxTags` is reached (input is disabled). */
  maxReachedPlaceholder?: string
  /** accessible label for each chip's remove button, e.g. t('submit.removeTag', { tag }). */
  removeTagLabel: (tag: string) => string
  /** optional SR announcements for add/remove (fills a polite live region). */
  announce?: { added: (tag: string) => string; removed: (tag: string) => string }
  id?: string
  fieldClassName?: string
}

/**
 * Controlled tag/chip editor matching the Pill visual language. Enter or comma adds
 * a tag; Backspace on an empty input removes the last; chips have a ≥40px accessible
 * remove control. Dedupes, trims, and caps by tag count + Unicode-aware length.
 */
export function TagInput({
  label,
  hint,
  invalid,
  value,
  onChange,
  maxTags = 8,
  maxTagLength = 32,
  placeholder,
  maxReachedPlaceholder,
  removeTagLabel,
  announce,
  id,
  fieldClassName,
}: TagInputProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  const hintId = hint ? `${inputId}-hint` : undefined

  const [buffer, setBuffer] = useState('')
  const [live, setLive] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const full = value.length >= maxTags

  const commit = (raw: string) => {
    const tag = limitByUnicode(raw.trim(), maxTagLength)
    if (!tag || full || value.includes(tag)) {
      setBuffer('')
      return
    }
    onChange([...value, tag])
    setBuffer('')
    if (announce) setLive(announce.added(tag))
  }

  const remove = (tag: string) => {
    onChange(value.filter((t) => t !== tag))
    if (announce) setLive(announce.removed(tag))
    inputRef.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Ignore keystrokes during IME composition (e.g. an Enter that only commits
    // a pinyin candidate); keyCode 229 covers Android/legacy composition.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault()
      commit(buffer)
    } else if (e.key === 'Backspace' && !buffer && value.length) {
      e.preventDefault()
      remove(value[value.length - 1]!)
    }
  }

  // A paste containing separators splits into multiple tags at once; a
  // separator-free paste falls through to the native handler (fills the buffer).
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    if (!PASTE_SPLIT.test(text)) return
    e.preventDefault()
    const next = [...value]
    const added: string[] = []
    for (const part of text.split(PASTE_SPLIT)) {
      const tag = limitByUnicode(part.trim(), maxTagLength)
      if (tag && next.length < maxTags && !next.includes(tag)) {
        next.push(tag)
        added.push(tag)
      }
    }
    if (added.length) {
      onChange(next)
      if (announce) setLive(announce.added(added.join('、')))
    }
  }

  return (
    <div className={cx(styles.field, fieldClassName)}>
      {label && (
        <label htmlFor={inputId} className={styles.label}>
          {label}
        </label>
      )}
      <div className={cx(styles.box, invalid && styles.invalid)}>
        {value.map((tag) => (
          <span key={tag} className={styles.chip}>
            <span className={styles.chipLabel}>{tag}</span>
            <button
              type="button"
              className={styles.remove}
              aria-label={removeTagLabel(tag)}
              // Prevent the input from blurring (which would auto-commit the
              // buffer as a spurious tag) before this click removes the chip.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => remove(tag)}
            >
              <CloseIcon />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          className={styles.input}
          value={buffer}
          disabled={full}
          placeholder={full ? maxReachedPlaceholder : placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={hintId}
          onChange={(e) => setBuffer(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => buffer.trim() && commit(buffer)}
        />
      </div>
      {hint && (
        <span id={hintId} className={cx(styles.hint, invalid && styles.hintError)}>
          {hint}
        </span>
      )}
      <span className={styles.srOnly} role="status" aria-live="polite">
        {live}
      </span>
    </div>
  )
}
