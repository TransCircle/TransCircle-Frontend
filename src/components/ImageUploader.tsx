import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { uploadFile } from '@/api/client'
import { ERRORS } from '@/api/errors'

interface ImageUploaderProps {
  onUploaded: (url: string) => void
}

export const ImageUploader = ({ onUploaded }: ImageUploaderProps) => {
  void useTranslation()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    setUploading(true)
    setError('')

    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      setError('仅支持 JPEG/PNG/GIF/WebP 格式')
      setUploading(false)
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('文件大小不能超过 2MB')
      setUploading(false)
      return
    }

    const result = await uploadFile(file)
    setUploading(false)

    if (result.ok) {
      onUploaded(result.data.url)
    } else {
      const code = result.error.code
      if (code === ERRORS.EMAIL_NOT_VERIFIED) setError('邮箱未验证，不能上传图片')
      else if (code === ERRORS.CONTENT_TOO_LARGE) setError('文件超过 2MB')
      else if (code === ERRORS.UNSUPPORTED_MEDIA_TYPE) setError('不支持的图片格式')
      else if (code === ERRORS.INVALID_IMAGE) setError('图片损坏或不符合要求')
      else setError(result.error.message || '上传失败')
    }
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        style={{ display: 'none' }}
        onChange={e => handleFile(e.target.files?.[0])}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        style={{ padding: '0.3rem 0.75rem', fontSize: '0.85rem', cursor: 'pointer' }}
      >
        {uploading ? '上传中...' : '上传图片'}
      </button>
      {error && <p style={{ color: '#c62828', fontSize: '0.8rem', marginTop: '0.25rem' }}>{error}</p>}
    </div>
  )
}
