import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { uploadFile } from '@/api/client'
import { ERRORS } from '@/api/errors'

interface ImageUploaderProps {
  onUploaded: (url: string) => void
}

export const ImageUploader = ({ onUploaded }: ImageUploaderProps) => {
  const { t } = useTranslation()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File | undefined) => {
    if (!file) return
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
      const result = await uploadFile(file)
      setUploading(false)

      if (result.ok) {
        onUploaded(result.data.url)
      } else {
        const code = result.error.code
        if (code === ERRORS.EMAIL_NOT_VERIFIED) setError(t('imageUploader.errorEmailNotVerified'))
        else if (code === ERRORS.CONTENT_TOO_LARGE) setError(t('imageUploader.errorTooLarge'))
        else if (code === ERRORS.UNSUPPORTED_MEDIA_TYPE) setError(t('imageUploader.errorUnsupported'))
        else if (code === ERRORS.INVALID_IMAGE) setError(t('imageUploader.errorInvalid'))
        else setError(result.error.message || t('imageUploader.errorFallback'))
      }
    } catch {
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
        style={{ display: 'none' }}
        onChange={e => {
          handleFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
          border: '1.5px solid var(--divider-color)', color: 'var(--text-main)',
          background: 'var(--bg-color)', padding: '0.55rem 1.25rem',
          borderRadius: '50px', fontSize: '0.88rem', fontWeight: 500,
          cursor: 'pointer', fontFamily: 'inherit',
          transition: 'border-color 0.15s ease'
        }}
      >
        {uploading ? t('imageUploader.uploading') : t('imageUploader.uploadButton')}
      </button>
      {error && <p role="alert" style={{ color: 'var(--error-color)', fontSize: '0.8rem', marginTop: '0.25rem' }}>{error}</p>}
    </div>
  )
}
