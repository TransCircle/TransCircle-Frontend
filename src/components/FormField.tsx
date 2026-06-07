import { useId, Children, isValidElement, cloneElement, type ReactNode, type ReactElement } from 'react'
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
function isLabelableElement(child: ReactElement): boolean {
  const { type } = child
  // <input>, <select>, <textarea> are labelable per HTML spec
  if (type === 'select' || type === 'textarea' || type === 'input') return true
  // Fallback: detect by props for wrapped/untyped elements
  const props = child.props as Record<string, unknown>
  return (
    typeof props.type === 'string' ||
    typeof props.multiple === 'boolean' ||
    typeof props.rows === 'number' ||
    typeof props.cols === 'number'
  )
}

export const FormField = ({ label, required, error, children, htmlFor }: FormFieldProps) => {
  const generatedId = useId()
  const errorId = `error-${generatedId}`
  const fieldId = htmlFor || `field-${generatedId}`

  // Determine if the first direct child is a labelable form element
  const firstChild = Children.toArray(children)[0]
  const firstIsLabelable = isValidElement(firstChild) && isLabelableElement(firstChild as React.ReactElement)
  // Only auto-associate the label when we have a valid target
  const canAutoAssociate = !!htmlFor || firstIsLabelable

  const enhanced = Children.map(children, (child) => {
    if (!isValidElement(child)) return child
    const props = child.props as Record<string, unknown>
    const extra: Record<string, unknown> = {}

    // Only inject id into labelable form elements (needed for <label htmlFor>).
    // For wrapper divs the caller manages ids manually via htmlFor prop.
    if (!htmlFor && !props.id && isLabelableElement(child)) {
      extra.id = fieldId
    }

    // Inject aria-describedby on any element so screen readers associate
    // the error message with the field, even when wrapped in a container div.
    if (error) {
      if (!props['aria-describedby']) extra['aria-describedby'] = errorId
      // aria-invalid is only meaningful on actual form controls
      if (isLabelableElement(child)) extra['aria-invalid'] = true
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
