import { useEffect, useRef } from 'react'
import { MdEditor } from 'md-editor-rt'
import 'md-editor-rt/lib/style.css'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/useTheme'
import { FormField } from './FormField'
import { ImageUploader } from './ImageUploader'
import styles from './MarkdownField.module.css'

interface MarkdownFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
  error?: string
  /** hint shown next to the image uploader; defaults to submit.imageHint */
  imageHint?: string
}

/**
 * Shared Markdown editing field (md-editor-rt + image upload), wrapped in the
 * accessible FormField label/error. Used by both the Submit and Edit-request
 * flows so the writing experience is identical.
 */
export const MarkdownField = ({ label, value, onChange, required, error, imageHint }: MarkdownFieldProps) => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  // Keep the latest value in a ref (synced via effect, not during render) so the
  // async image-upload callback appends to current content without a stale closure.
  const valueRef = useRef(value)
  useEffect(() => {
    valueRef.current = value
  }, [value])

  // The rich-text editor only ships 'light' / 'dark' skins; map the app theme through.
  const editorTheme = theme === 'light' ? 'light' : 'dark'
  // md-editor-rt 仅内置 zh-CN / en-US 语言包；本项目仅 zh-CN / zh-TW，两者均复用中文 UI。
  const editorLanguage = 'zh-CN'

  return (
    <FormField label={label} required={required} error={error}>
      <div className={styles.editorWrapper} role="group" aria-label={label}>
        <MdEditor
          value={value}
          onChange={onChange}
          theme={editorTheme}
          language={editorLanguage}
          preview={true}
          toolbarsExclude={['image', 'link', 'mermaid', 'katex', 'github']}
        />
      </div>
      <div className={styles.imageRow}>
        <ImageUploader onUploaded={(url) => onChange(valueRef.current + `\n![image](${url})\n`)} />
        <span className={styles.imageHint}>{imageHint ?? t('submit.imageHint')}</span>
      </div>
    </FormField>
  )
}
