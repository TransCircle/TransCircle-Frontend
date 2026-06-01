import { useId, Children, isValidElement, cloneElement, type ReactNode } from 'react'
import { FieldErrorContext } from './FieldError'
import styles from './FormField.module.css'

interface FormFieldProps {
  label: string
  required?: boolean
  error?: string
  children: ReactNode
  htmlFor?: string
}

/** Elements that accept `htmlFor` / are "labelable" per HTML spec */
function isLabelableElement(props: Record<string, unknown>): boolean {
  return (
    typeof props.type === 'string' ||      // <input type="...">
    typeof props.multiple === 'boolean' || // <select multiple>
    typeof props.rows === 'number' ||      // <textarea rows=...>
    typeof props.cols === 'number'
  )
}

export const FormField = ({ label, required, error, children, htmlFor }: FormFieldProps) => {
  const generatedId = useId()
  const errorId = `error-${generatedId}`
  const fieldId = htmlFor || `field-${generatedId}`

  // Determine if the first direct child is a labelable form element
  const firstChild = Children.toArray(children)[0]
  const firstIsLabelable = isValidElement(firstChild) && isLabelableElement((firstChild as React.ReactElement).props as Record<string, unknown>)
  // Only auto-associate the label when we have a valid target
  const canAutoAssociate = !!htmlFor || firstIsLabelable

  const enhanced = Children.map(children, (child) => {
    if (!isValidElement(child)) return child
    const props = child.props as Record<string, unknown>
    const extra: Record<string, unknown> = {}

    // Only inject id into labelable form elements (needed for <label htmlFor>).
    // For wrapper divs the caller manages ids manually via htmlFor prop.
    if (!htmlFor && !props.id && isLabelableElement(props)) {
      extra.id = fieldId
    }

    // Inject aria-describedby on any element so screen readers associate
    // the error message with the field, even when wrapped in a container div.
    if (error) {
      if (!props['aria-describedby']) extra['aria-describedby'] = errorId
      // aria-invalid is only meaningful on actual form controls
      if (isLabelableElement(props)) extra['aria-invalid'] = true
    }

    return Object.keys(extra).length > 0 ? cloneElement(child, extra) : child
  })

  return (
    <FieldErrorContext.Provider value={error ? errorId : null}>
      <div className={styles.fieldWrapper}>
        {label && canAutoAssociate && (
          <label htmlFor={fieldId} className={styles.label}>
            {label}
            {required && <span className={styles.required}>*</span>}
          </label>
        )}
        {label && !canAutoAssociate && (
          <label className={styles.label}>
            {label}
            {required && <span className={styles.required}>*</span>}
          </label>
        )}
        {enhanced}
        {error && (
          <p id={errorId} className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </FieldErrorContext.Provider>
  )
}
