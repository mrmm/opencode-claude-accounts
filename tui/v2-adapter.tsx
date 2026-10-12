/** @jsxImportSource @opentui/solid */
/**
 * Runs the V1 TUI plugin on the OpenCode 2 CLI plugin API.
 *
 * V2 replaced the component dialogs (`<DialogSelect onSelect>` passed to
 * `dialog.replace`) with promise dialogs, `slots.register` with `ui.slot`, and
 * `keymap.registerLayer` with `keymap.layer`. Every screen in the V1 module is
 * written against the old shapes, so rather than rewrite ~1700 lines of
 * navigation this provides the subset of the V1 API that module uses:
 *
 *   ui.DialogSelect/Prompt/Confirm  -> markers that `dialog.replace` turns
 *                                      into the matching promise dialog
 *   ui.dialog.replace(render, esc)  -> newest dialog wins; escape calls `esc`
 *   ui.toast                        -> ui.toast.show
 *   theme.current.*                 -> semantic V2 theme tokens
 *   slots.register                  -> ui.slot
 *   keymap.registerLayer            -> keymap.layer
 *
 * V1 select dialogs had no key hooks, so reordering was done by typing + or -
 * into the filter (onFilter) at the row last highlighted (onMove). V2 has
 * neither hook; the same two keys are offered as dialog actions on the
 * highlighted row instead.
 */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Plugin } from "@opencode/plugin/tui"
import { createRoot } from "solid-js"

type Context = Plugin.Context
type Row = {
  title: string
  value: unknown
  description?: string
  footer?: string
  category?: string
  disabled?: boolean
}

const MARK = Symbol.for("claude-auth.v1-dialog")
type Kind = "select" | "prompt" | "confirm"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Props = Record<string, any>

const marker = (kind: Kind) => (props: Props) =>
  ({ [MARK]: kind, props }) as unknown as never

// V2 theme leaves may be a colour or a { base, ... } state set.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const color = (value: any) =>
  value && typeof value === "object" && "base" in value ? value.base : value

// V1 slot names -> V2 slot paths.
const SLOTS: Record<string, "prompt.footer.status" | "sidebar.content"> = {
  session_prompt_right: "prompt.footer.status",
  sidebar_content: "sidebar.content",
}

function adapt(ctx: Context): TuiPluginApi {
  // Each dialog belongs to one generation. Showing another dialog resolves
  // the previous promise with `undefined`, which must not read as escape.
  let generation = 0

  const replace = (render: () => unknown, onClose?: () => void) => {
    const mine = ++generation
    const current = () => mine === generation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const element = render() as any
    const kind = element?.[MARK] as Kind | undefined
    if (!kind) {
      ctx.ui.dialog.show(() => element, onClose)
      return
    }
    const props = element.props as Props
    // Solid compiles JSX props to getters: read each once.
    const title = String(props.title ?? "")

    if (kind === "select") {
      const rows = (props.options ?? []) as Row[]
      const byValue = (value: unknown) => rows.find((r) => r.value === value)
      const reorder = props.onMove || props.onFilter
      void ctx.ui.dialog
        .select<unknown>({
          title,
          current: props.current,
          options: rows.map((r) => ({
            title: r.title,
            value: r.value,
            ...(r.description !== undefined
              ? { description: r.description }
              : {}),
            ...(r.footer !== undefined ? { footer: r.footer } : {}),
            ...(r.category !== undefined ? { category: r.category } : {}),
            ...(r.disabled !== undefined ? { disabled: r.disabled } : {}),
          })),
          ...(reorder
            ? {
                actions: (["+", "-"] as const).map((key) => ({
                  bind: key,
                  title: key === "+" ? "Move up" : "Move down",
                  onTrigger: (value: unknown) => {
                    props.onMove?.(byValue(value))
                    props.onFilter?.(key)
                  },
                })),
              }
            : {}),
        })
        .then((value) => {
          if (!current()) return
          if (value === undefined) return onClose?.()
          props.onSelect?.(byValue(value))
        })
      return
    }

    if (kind === "prompt") {
      void ctx.ui.dialog
        .prompt({
          title,
          ...(props.placeholder !== undefined
            ? { placeholder: String(props.placeholder) }
            : {}),
          ...(props.value !== undefined ? { value: String(props.value) } : {}),
        })
        .then((value) => {
          if (!current()) return
          if (value === undefined)
            return onClose ? onClose() : props.onCancel?.()
          props.onConfirm?.(value)
        })
      return
    }

    void ctx.ui.dialog
      .confirm({ title, message: String(props.message ?? "") })
      .then((ok) => {
        if (!current()) return
        if (ok === true) return props.onConfirm?.()
        if (ok === false) return props.onCancel?.()
        return onClose ? onClose() : props.onCancel?.()
      })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const theme = ctx.theme as any
  const api = {
    ui: {
      dialog: {
        replace,
        clear: () => {
          generation++
          ctx.ui.dialog.clear()
        },
      },
      DialogSelect: marker("select"),
      DialogPrompt: marker("prompt"),
      DialogConfirm: marker("confirm"),
      toast: (input: {
        title?: string
        message: string
        variant?: "info" | "success" | "warning" | "error"
        duration?: number
      }) => ctx.ui.toast.show(input),
    },
    theme: {
      current: {
        get text() {
          return color(theme.text?.base)
        },
        get textMuted() {
          return color(theme.text?.muted)
        },
        get error() {
          return color(theme.text?.feedback?.error)
        },
        get warning() {
          return color(theme.text?.feedback?.warning)
        },
        get success() {
          return color(theme.text?.feedback?.success)
        },
        get info() {
          return color(theme.text?.feedback?.info)
        },
      },
    },
    slots: {
      register(input: {
        slots: Record<string, (ctx: unknown, props: Props) => unknown>
      }) {
        for (const [name, render] of Object.entries(input.slots)) {
          const path = SLOTS[name]
          if (!path) continue
          ctx.ui.slot({
            append: path,
            render: (slot: Props) =>
              render(undefined, {
                ...slot,
                session_id: slot.sessionID,
              }) as never,
          } as never)
        }
      },
    },
    keymap: {
      registerLayer(input: {
        commands: Array<{
          name: string
          title: string
          category?: string
          slashName?: string
          run: () => unknown
        }>
        bindings?: Array<{ key: string; cmd: string }>
      }) {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: input.commands.map((c) => ({
            id: c.name,
            title: c.title,
            ...(c.category ? { group: c.category } : {}),
            palette: true as const,
            ...(c.slashName ? { slash: { name: c.slashName } } : {}),
            bind: input.bindings?.find((b) => b.cmd === c.name)?.key ?? false,
            run: () => {
              void c.run()
            },
          })),
          bindings: input.commands.map((c) => c.name),
        }))
      },
    },
  }
  return api as unknown as TuiPluginApi
}

export function setupV2(ctx: Context, tui: TuiPlugin) {
  // V1 ran the plugin inside a reactive owner (it uses onCleanup); give it one
  // and tie its disposal to the V2 plugin's lifetime.
  return createRoot((dispose) => {
    void (tui as unknown as (api: TuiPluginApi, options: unknown) => unknown)(
      adapt(ctx),
      ctx.options,
    )
    return dispose
  })
}
