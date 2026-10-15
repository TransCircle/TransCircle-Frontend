import { useEffect, useRef, useState } from 'react'
import { MdEditor, type ExposeParam } from 'md-editor-rt'
import 'md-editor-rt/lib/style.css'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/useTheme'
import { useMediaQuery } from '@/hooks/useMediaQuery'
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
  /* 并排预览只在宽视口默认打开：手机上编辑区与预览各占半宽，两边都读不了。
     窄屏仍可用工具栏的预览按钮手动切换。 */
  const sideBySidePreview = useMediaQuery('(min-width: 769px)')
  /* preview 属性只在编辑器初始化时读取一次；之后跨断点（缩窗、旋转设备）要经 ref 同步，
     不能靠重挂载——那会丢掉撤销历史与光标位置。 */
  const editorRef = useRef<ExposeParam>(null)
  /* 用户主动切到「仅预览」或「HTML 预览」时不干预：togglePreview 会把这两种模式一并清掉。
     两种模式都退出后按当前断点补一次同步（期间可能缩窗或旋转过设备）。 */
  const [previewOnly, setPreviewOnly] = useState(false)
  const [htmlPreview, setHtmlPreview] = useState(false)
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.on('previewOnly', setPreviewOnly)
    editor.on('htmlPreview', setHtmlPreview)
  }, [])
  useEffect(() => {
    if (previewOnly || htmlPreview) return
    editorRef.current?.togglePreview(sideBySidePreview)
  }, [sideBySidePreview, previewOnly, htmlPreview])

  return (
    <FormField label={label} required={required} error={error}>
      <div className={styles.editorWrapper} role="group" aria-label={label}>
        <MdEditor
          ref={editorRef}
          value={value}
          onChange={onChange}
          theme={editorTheme}
          language={editorLanguage}
          preview={sideBySidePreview}
          /* 库默认对 default 预览主题反转代码高亮（亮色也用 atom-one-dark）；代码块底已改为
             --code-bg（亮色是浅底），高亮皮肤必须跟随实际主题。 */
          codeStyleReverse={false}
          /* 另外排除：save（没有接 onSave，点了没有任何效果）；fullscreen / pageFullscreen
             （库直接写 body.style.overflow 且卸载时不还原，离开页面后整站滚动被锁死）。 */
          toolbarsExclude={['image', 'link', 'mermaid', 'katex', 'github', 'save', 'fullscreen', 'pageFullscreen']}
        />
      </div>
      <div className={styles.imageRow}>
        <ImageUploader onUploaded={(url) => onChange(valueRef.current + `\n![image](${url})\n`)} />
        <span className={styles.imageHint}>{imageHint ?? t('submit.imageHint')}</span>
      </div>
    </FormField>
  )
}
