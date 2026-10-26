/**
 * Sidebar foot card mounting.
 *
 * The foot's only slot (sidebar.footer.action) stacks ABOVE the Settings row
 * and cannot host a block, so the card container is inserted into the shell's
 * foot area directly above the Settings seat — keeping Settings the foot's
 * terminal row instead of hanging a card off the sidebar floor. It self-heals
 * with the page-wide body-mutation hub: a React re-render that displaces the
 * container re-seats it on the next frame, and a whole-pane rebuild is noticed
 * by the same body-level watcher the family entry rows use.
 *
 * The container is a plain div carrying its own React root, so it can never
 * disturb the shell's reconciliation.
 * @module @linxin666/dsh-usage/client/foot-card-mount
 */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { subscribeBodyInvalidations } from './body-mutations.ts'
import { UsageFootCard, type UsageFootCardProps } from './UsageFootCard.tsx'

/** Stable data attribute identifying the injected card container. */
export const FOOT_CARD_SELECTOR = '[data-dsh-usage-foot-card]'

/**
 * The shortcuts registry face the shell's settings.open command is invoked
 * through; restated here because dsh-client-shortcuts ships no client types.
 */
export interface ShortcutsRegistryFace {
  invoke(id: string, context: { target: unknown; region: string; modal: string | null }): void
}

/** The shortcuts service face the apply body hands in, when the host serves it. */
export interface ShortcutsServiceFace {
  registry?: ShortcutsRegistryFace
}

/** Optional host faces the settings opener consumes; every one may be absent. */
export interface UsageSettingsOpenerFaces {
  /** Shell keyboard command registry; absent when the host predates it. */
  shortcuts?: ShortcutsServiceFace
}

/** The shell sidebar's foot area (footer actions + the Settings row), when mounted. */
function footArea(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  return column?.querySelector<HTMLElement>('[class*="footArea"]') ?? undefined
}

/**
 * Open the settings panel on the usage section. The shell owns the panel's
 * open state and seats the ACCOUNT menu at the sidebar foot, whose 设置
 * (Ctrl+,) item is what opens the dialog.
 *
 * The fast path invokes the shell's own settings.open command through the
 * shortcuts registry: on Desktop Windows/macOS real keys are routed through
 * the native preload bridge and the DOM keydown listener returns before
 * dispatch, so a synthetic Ctrl+, never lands there, while the registry call
 * opens the dialog on every runtime with no menu flash. Only when no registry
 * arrived — or the command never landed — does the card open the account menu
 * and click its 设置 item, the visible fallback. Every step degrades silently.
 *
 * @param label - the usage section's nav label in the active locale.
 * @param faces - optional host faces from the apply body (the shortcuts service).
 */
export function openUsageSettings(label: () => string, faces?: UsageSettingsOpenerFaces): void {
  /** Click the nav row carrying the usage label inside the open dialog. */
  const pick = (panel: Element): void => {
    const wanted = label()
    for (const row of panel.querySelectorAll<HTMLButtonElement>('nav button')) {
      if (row.textContent !== null && row.textContent.includes(wanted)) {
        row.click()
        return
      }
    }
    // Panel open but the usage row is gone (plugin toggled off): stay put.
  }

  // The settings dialog carries the shell's own modal marker; a bare
  // [role=dialog] also matches the account menu and other popovers.
  const settingsDialog = (): Element | null => document.querySelector('[data-shortcut-modal="settings"]')

  /**
   * The account menu's 设置 item, when that menu has opened. The item may
   * carry its Ctrl+, shortcut glued to the word, so the hint is stripped
   * before an exact match keeps generic 设置-prefixed rows out.
   */
  const accountSettingsItem = (): HTMLElement | null => {
    const menus = document.querySelectorAll('[role="menu"], [role="dialog"]:not([data-shortcut-modal="settings"])')
    for (const menu of menus) {
      for (const candidate of menu.querySelectorAll<HTMLElement>('button, [role="menuitem"]')) {
        const name = `${candidate.textContent ?? ''} ${candidate.getAttribute('aria-label') ?? ''}`.replace(/\s+/g, ' ').replace(/\s*Ctrl\+.*$/, '').trim()
        if (name === '设置' || name === 'Settings') return candidate
      }
    }
    return null
  }

  /** The sidebar's settings-area trigger: the old launcher, else the account entry. */
  const trigger = (): HTMLButtonElement | null => {
    const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
    return column?.querySelector<HTMLButtonElement>('[class*="settingsArea"] button[aria-haspopup="dialog"]')
      ?? column?.querySelector<HTMLButtonElement>('[class*="settingsArea"] button')
      ?? null
  }

  // A dialog that is already open must never be toggled shut; only the nav
  // pick runs.
  const open = settingsDialog()
  if (open !== null) {
    pick(open)
    return
  }

  // Fast path: the shell's own settings.open command through the shortcuts
  // registry. The command's resolve treats a null modal as "open", and its run
  // flips the settings shell's store directly — the account menu never paints.
  try {
    faces?.shortcuts?.registry?.invoke('settings.open', { target: null, region: 'page', modal: null })
  } catch {
    // A host with an incompatible registry face: the menu fallback below runs.
  }

  let tries = 0
  let openedMenu = false
  const attempt = (): void => {
    const dialog = settingsDialog()
    if (dialog !== null) {
      pick(dialog)
      return
    }
    // The command did not land (no registry face, unbound, or an incompatible
    // host): fall back to the visible path — the account menu, then its 设置
    // item. An already-open menu skips the trigger click, which would toggle
    // it shut.
    if (tries >= 5) {
      if (!openedMenu) {
        const item = accountSettingsItem()
        if (item !== null) {
          item.click()
          openedMenu = true
        } else {
          trigger()?.click()
        }
      }
    }
    tries += 1
    // The panel mounts on the shell's next frames; wait briefly, then give up.
    if (tries <= 24) window.setTimeout(attempt, 50)
  }
  window.setTimeout(attempt, 0)
}

/**
 * Mount the sidebar foot card directly above the Settings row.
 * @param props - the store/poll/settings/open inputs of the apply body.
 * @returns disposer removing the container and its observers.
 */
export function mountUsageFootCard(props: UsageFootCardProps): () => void {
  // DOM-level idempotency: whatever path mounted a card before this call (a
  // duplicated apply, an HMR re-injection), never mount a second one.
  if (typeof document !== 'undefined' && document.querySelector(FOOT_CARD_SELECTOR) !== null) {
    return () => {}
  }
  const container = document.createElement('div')
  container.setAttribute('data-dsh-usage-foot-card', '')
  const root: Root = createRoot(container)
  root.render(createElement(UsageFootCard, props))

  /** Keep the container directly above the Settings seat inside the foot area. */
  const place = (): void => {
    const foot = footArea()
    if (foot === undefined) return
    const settings = foot.querySelector<HTMLElement>('[class*="settingsArea"]')
    if (settings !== null) {
      if (container.nextElementSibling !== settings) foot.insertBefore(container, settings)
      return
    }
    // No Settings seat to anchor against (shell change): fall back to the tail.
    if (foot.lastElementChild !== container) foot.append(container)
  }
  place()
  const unsubscribeBody = subscribeBodyInvalidations(place)

  return () => {
    unsubscribeBody()
    root.unmount()
    container.remove()
  }
}
