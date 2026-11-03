import { Label, ListBox, Select } from '@heroui/react'

interface Props<T extends string> {
  label?: string
  ariaLabel?: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  className?: string
}

export function SimpleSelect<T extends string>({ label, ariaLabel, value, options, onChange, className }: Props<T>) {
  return (
    <Select
      className={className}
      aria-label={ariaLabel ?? label}
      value={value}
      onChange={(v) => v != null && onChange(String(v) as T)}
    >
      {label && <Label>{label}</Label>}
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((o) => (
            <ListBox.Item key={o.value} id={o.value} textValue={o.label}>
              {o.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}
