import { styleText } from 'node:util'
import type { Readable, Writable } from 'node:stream'
import { SelectPrompt, settings, wrapTextWithPrefix, type State } from '@clack/core'

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

