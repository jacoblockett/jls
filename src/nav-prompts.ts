import { styleText } from 'node:util'
import type { Readable, Writable } from 'node:stream'
import { SelectPrompt, TextPrompt, settings, wrapTextWithPrefix, type State } from '@clack/core'

export const BACK_SIGNAL = Symbol('jls-back')

export type NavOption<Value> = {
  value: Value
  label: string
  disabled?: boolean
}

type CommonNavOptions = {
  input?: Readable
  output?: Writable
  signal?: AbortSignal
  withGuide?: boolean
  allowBack?: boolean
}

export type NavSelectOptions<Value> = CommonNavOptions & {
  message: string
  options: NavOption<Value>[]
  initialValue?: Value
  onCursor?: (value: Value) => void
}

export type NavTextOptions = CommonNavOptions & {
  message: string
  placeholder?: string
  initialValue?: string
  validate?: (value: string | undefined) => string | Error | undefined
  onInput?: (value: string) => void
}

const S_STEP_ACTIVE = '◆'
const S_STEP_CANCEL = '■'
const S_STEP_ERROR = '▲'
const S_STEP_SUBMIT = '◇'
const S_BAR = '│'
const S_BAR_END = '└'
const S_RADIO_ACTIVE = '●'
const S_RADIO_INACTIVE = '○'

function symbol(state: State): string {
  if (state === 'cancel') return styleText('red', S_STEP_CANCEL)
  if (state === 'error') return styleText('yellow', S_STEP_ERROR)
  if (state === 'submit') return styleText('green', S_STEP_SUBMIT)
  return styleText('cyan', S_STEP_ACTIVE)
}

function symbolBar(state: State): string {
  if (state === 'cancel') return styleText('red', S_BAR)
  if (state === 'error') return styleText('yellow', S_BAR)
  if (state === 'submit') return styleText('green', S_BAR)
  return styleText('cyan', S_BAR)
}

function footer(hasGuide: boolean, allowBack: boolean, text = false): string {
  const pieces = text
    ? [
        `${styleText('dim', 'Enter')} confirm`,
        ...(allowBack ? [`${styleText('dim', 'Backspace')} back`] : []),
        `${styleText('dim', 'Esc')} exit`,
      ]
    : [
        `${styleText('dim', '↑/↓')} navigate`,
        `${styleText('dim', 'Enter')} confirm`,
        ...(allowBack ? [`${styleText('dim', 'Backspace')} back`] : []),
        `${styleText('dim', 'Esc')} exit`,
      ]
  const line = `${hasGuide ? `${styleText('cyan', S_BAR)}  ` : ''}${pieces.join(' • ')}`
  return hasGuide ? `${line}\n${styleText('cyan', S_BAR_END)}` : line
}

function blankGuide(hasGuide: boolean): string {
  return hasGuide ? styleText('cyan', S_BAR) : ''
}

function backHistory(hasGuide: boolean): string {
  return `${hasGuide ? `${styleText('gray', S_BAR)}  ` : ''}${styleText('dim', 'Go back')}`
}

class BackSelectPrompt<Value> extends SelectPrompt<NavOption<Value>> {
  backRequested = false

  constructor(
    opts: any,
    allowBack: boolean,
    onCursor?: (value: Value) => void,
  ) {
    super(opts)
    const report = () => {
      const option = this.options[this.cursor]
      if (option) onCursor?.(option.value)
    }
    report()
    this.on('cursor', report)
    this.on('key', (_char, key) => {
      if (allowBack && key.name === 'backspace') {
        this.backRequested = true
        this.state = 'submit'
      }
    })
  }
}

function selectOptionText<Value>(
  option: NavOption<Value> | undefined,
  state: 'inactive' | 'active' | 'selected' | 'cancelled' | 'disabled',
): string {
  if (!option) return ''
  const label = option.label
  if (state === 'disabled') return `${styleText('gray', S_RADIO_INACTIVE)} ${styleText('gray', label)}`
  if (state === 'selected') return styleText('dim', label)
  if (state === 'active') return `${styleText('green', S_RADIO_ACTIVE)} ${label}`
  if (state === 'cancelled') return styleText(['strikethrough', 'dim'], label)
  return `${styleText('dim', S_RADIO_INACTIVE)} ${styleText('dim', label)}`
}

export async function navSelect<Value>(opts: NavSelectOptions<Value>): Promise<Value | symbol> {
  const output = opts.output ?? process.stdout
  const hasGuide = opts.withGuide ?? settings.withGuide
  const allowBack = opts.allowBack ?? true
  let prompt!: BackSelectPrompt<Value>

  prompt = new BackSelectPrompt<Value>({
    options: opts.options,
    input: opts.input,
    output: opts.output,
    signal: opts.signal,
    initialValue: opts.initialValue,
    render() {
      const wrappedMessage = wrapTextWithPrefix(
        output,
        opts.message,
        hasGuide ? `${symbolBar(this.state)}  ` : '',
        `${symbol(this.state)}  `,
      )
      const title = `${hasGuide ? `${styleText('gray', S_BAR)}\n` : ''}${wrappedMessage}\n`
      if (this.state === 'submit') {
        if (prompt.backRequested) return `${title}${backHistory(hasGuide)}`
        return `${title}${hasGuide ? `${styleText('gray', S_BAR)}  ` : ''}${selectOptionText(this.options[this.cursor], 'selected')}`
      }
      if (this.state === 'cancel') {
        return `${title}${hasGuide ? `${styleText('gray', S_BAR)}  ` : ''}${selectOptionText(this.options[this.cursor], 'cancelled')}${hasGuide ? `\n${styleText('gray', S_BAR)}` : ''}`
      }
      const prefix = hasGuide ? `${styleText(this.state === 'error' ? 'yellow' : 'cyan', S_BAR)}  ` : ''
      const lines = this.options.map((option: NavOption<Value>, index: number) => selectOptionText(
        option,
        option.disabled ? 'disabled' : index === this.cursor ? 'active' : 'inactive',
      ))
      return `${title}${prefix}${lines.join(`\n${prefix}`)}\n${blankGuide(hasGuide)}\n${footer(hasGuide, allowBack)}\n`
    },
  }, allowBack, opts.onCursor)

  const value = await prompt.prompt()
  if (prompt.backRequested) return BACK_SIGNAL
  return value as Value | symbol
}

class BackTextPrompt extends TextPrompt {
  backRequested = false
  private hadInput: boolean

  constructor(
    opts: any,
    private readonly allowBack: boolean,
    onInput?: (value: string) => void,
  ) {
    super(opts)
    this.hadInput = !!opts.initialValue
    this.on('userInput', (value) => onInput?.(value ?? ''))
    this.on('key', (_char, key) => {
      if (this.allowBack && key.name === 'backspace' && !this.hadInput) {
        this.backRequested = true
        this.state = 'submit'
      }
      this.hadInput = this.userInput.length > 0
    })
  }
}

export async function navText(opts: NavTextOptions): Promise<string | symbol> {
  const hasGuide = opts.withGuide ?? settings.withGuide
  const allowBack = opts.allowBack ?? true
  let prompt!: BackTextPrompt
  prompt = new BackTextPrompt({
    validate: opts.validate,
    placeholder: opts.placeholder,
    initialValue: opts.initialValue,
    output: opts.output,
    signal: opts.signal,
    input: opts.input,
    render() {
      const titlePrefix = `${hasGuide ? `${styleText('gray', S_BAR)}\n` : ''}${symbol(this.state)}  `
      const title = `${titlePrefix}${opts.message}\n`
      const placeholder = opts.placeholder && opts.placeholder.length > 0
        ? styleText('inverse', opts.placeholder[0]) + styleText('dim', opts.placeholder.slice(1))
        : styleText(['inverse', 'hidden'], '_')
      const userInput = !this.userInput ? placeholder : this.userInputWithCursor
      const value = this.value ?? ''

      if (this.state === 'error') {
        const errorText = this.error ? `  ${styleText('yellow', this.error)}` : ''
        return `${title.trim()}\n${hasGuide ? `${styleText('yellow', S_BAR)}  ` : ''}${userInput}\n${hasGuide ? styleText('yellow', S_BAR_END) : ''}${errorText}\n`
      }
      if (this.state === 'submit') {
        if (prompt.backRequested) return `${title}${backHistory(hasGuide)}`
        return `${title}${hasGuide ? styleText('gray', S_BAR) : ''}${value ? `  ${styleText('dim', value)}` : ''}`
      }
      if (this.state === 'cancel') {
        return `${title}${hasGuide ? styleText('gray', S_BAR) : ''}${value ? `  ${styleText(['strikethrough', 'dim'], value)}` : ''}`
      }
      return `${title}${hasGuide ? `${styleText('cyan', S_BAR)}  ` : ''}${userInput}\n${blankGuide(hasGuide)}\n${footer(hasGuide, allowBack, true)}\n`
    },
  }, allowBack, opts.onInput)

  const value = await prompt.prompt()
  if (prompt.backRequested) return BACK_SIGNAL
  return value as string | symbol
}
