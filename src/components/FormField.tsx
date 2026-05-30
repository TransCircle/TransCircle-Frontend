import { useId, type ReactNode } from 'react'
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

  return (
    <div className={styles.fieldWrapper}>
      {label && (
        <label htmlFor={fieldId} className={styles.label}>
          {label}
          {required && <span className={styles.required}>*</span>}
        </label>
      )}
      {children}
      {error && (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export default FormField
