import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { uploadFile } from '@/api/client'
import { ERRORS } from '@/api/errors'
import { AdminButton, Alert } from '@/components/ui'

interface ImageUploaderProps {
  onUploaded: (url: string) => void
}

const UploadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M17 8l-5-5-5 5" />
    <path d="M12 3v12" />
  </svg>
)

export const ImageUploader = ({ onUploaded }: ImageUploaderProps) => {
  const { t } = useTranslation()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const currentUploadRef = useRef<AbortController | null>(null)

  const handleFile = async (file: File | undefined) => {
    if (!file) return

    // 取消正在进行的旧上传，避免并发覆盖结果
    if (currentUploadRef.current) {
      currentUploadRef.current.abort()
    }
    const controller = new AbortController()
    currentUploadRef.current = controller

    setUploading(true)
    setError('')

    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      setError(t('imageUploader.errorFormat'))
      setUploading(false)
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setError(t('imageUploader.errorSize'))
      setUploading(false)
      return
    }

    try {
      const result = await uploadFile(file, controller.signal)

      // 如果此上传已被取消（新上传已启动），忽略结果
      if (controller.signal.aborted) return

      setUploading(false)
      currentUploadRef.current = null

      if (result.ok) {
        // 深层防御：验证返回的 URL 是合法的 HTTP(S) 链接
        const url = result.data.url
        try {
          const parsed = new URL(url)
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            setError(t('imageUploader.errorInvalid'))
            return
          }
        } catch {
          setError(t('imageUploader.errorInvalid'))
          return
        }
        onUploaded(url)
      } else {
        const code = result.error.code
        if (code === ERRORS.EMAIL_NOT_VERIFIED) setError(t('imageUploader.errorEmailNotVerified'))
        else if (code === ERRORS.CONTENT_TOO_LARGE) setError(t('imageUploader.errorTooLarge'))
        else if (code === ERRORS.UNSUPPORTED_MEDIA_TYPE) setError(t('imageUploader.errorUnsupported'))
        else if (code === ERRORS.INVALID_IMAGE) setError(t('imageUploader.errorInvalid'))
        else setError(result.error.message || t('imageUploader.errorFallback'))
      }
    } catch (err) {
      // 用户取消上传不显示错误
      if (err instanceof DOMException && err.name === 'AbortError') return
      setUploading(false)
      setError(t('imageUploader.errorNetwork'))
    }
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        aria-hidden="true"
        tabIndex={-1}
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
        onChange={e => {
          handleFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <AdminButton
        type="button"
        variant="secondary"
        size="sm"
        loading={uploading}
        iconLeft={<UploadIcon />}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? t('imageUploader.uploading') : t('imageUploader.uploadButton')}
      </AdminButton>
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  )
}
