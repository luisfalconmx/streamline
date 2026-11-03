import { Button, InputGroup, Spinner, TextField } from '@heroui/react'
import { ClipboardPaste, Link2, Search, X } from 'lucide-react'
import { looksLikeUrl } from '../lib/format'
import { readClipboard } from '../lib/tauri'

interface Props {
  value: string
  onChange: (v: string) => void
  onSubmit: (url: string) => void
  loading: boolean
  compact?: boolean
}

export function UrlBar({ value, onChange, onSubmit, loading, compact }: Props) {
  const valid = looksLikeUrl(value)

  const paste = async () => {
    const text = (await readClipboard()).trim()
    if (text) {
      onChange(text)
      if (looksLikeUrl(text)) onSubmit(text)
    }
  }

  return (
    <form
      className="flex w-full items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && !loading) onSubmit(value.trim())
      }}
    >
      <TextField
        aria-label="URL del video"
        className="flex-1"
        value={value}
        onChange={onChange}
        autoFocus
      >
        <InputGroup className={compact ? 'h-11' : 'h-14 text-base'}>
          <InputGroup.Prefix>
            <Link2 className="size-5 text-muted" />
          </InputGroup.Prefix>
          <InputGroup.Input
            className="w-full"
            placeholder="Pega aquí el enlace de YouTube, TikTok, Instagram, X, Vimeo…"
            spellCheck={false}
            autoComplete="off"
          />
          {value && (
            <InputGroup.Suffix>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="Limpiar"
                onPress={() => onChange('')}
              >
                <X className="size-4" />
              </Button>
            </InputGroup.Suffix>
          )}
        </InputGroup>
      </TextField>
      <Button
        variant="secondary"
        size={compact ? 'md' : 'lg'}
        className={compact ? 'h-11' : 'h-14'}
        onPress={paste}
        isDisabled={loading}
      >
        <ClipboardPaste className="size-4" />
        Pegar
      </Button>
      <Button
        type="submit"
        size={compact ? 'md' : 'lg'}
        className={compact ? 'h-11 min-w-32' : 'h-14 min-w-36'}
        isDisabled={!valid || loading}
      >
        {loading ? <Spinner size="sm" color="current" /> : <Search className="size-4" />}
        {loading ? 'Analizando' : 'Analizar'}
      </Button>
    </form>
  )
}
