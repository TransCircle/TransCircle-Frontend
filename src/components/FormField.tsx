import type { ReactNode } from 'react'
import styles from './FormField.module.css'

interface FormFieldProps {
  label: string
  required?: boolean
  error?: string
  children: ReactNode
}

const FormField = ({ label, required, error, children }: FormFieldProps) => {
  return (
    <div className={styles.fieldWrapper}>
      <span className={styles.label}>
        {label}
        {required && <span className={styles.required}>*</span>}
      </span>
      {children}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  )
}

export default FormField
