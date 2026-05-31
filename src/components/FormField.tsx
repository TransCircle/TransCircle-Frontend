import { useId, Children, isValidElement, cloneElement, type ReactNode } from 'react'
import styles from './FormField.module.css'

interface FormFieldProps {
  label: string
  required?: boolean
  error?: string
  children: ReactNode
  htmlFor?: string
}

const FormField = ({ label, required, error, children, htmlFor }: FormFieldProps) => {
  const generatedId = useId()
  const errorId = `error-${generatedId}`
  const fieldId = htmlFor || `field-${generatedId}`

  const enhanced = Children.map(children, (child) => {
    if (!isValidElement(child)) return child
    const props = child.props as Record<string, unknown>
    const extra: Record<string, unknown> = {}
    if (!props.id) extra.id = fieldId
    if (error && !props['aria-describedby']) extra['aria-describedby'] = errorId
    if (error) extra['aria-invalid'] = true
    return cloneElement(child, extra)
  })

  return (
    <div className={styles.fieldWrapper}>
      {label && (
        <label htmlFor={fieldId} className={styles.label}>
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
  )
}

export default FormField
