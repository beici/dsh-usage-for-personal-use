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
import { type UsageFootCardProps } from './UsageFootCard.tsx';
/** Stable data attribute identifying the injected card container. */
export declare const FOOT_CARD_SELECTOR = "[data-dsh-usage-foot-card]";
/**
 * The shortcuts registry face the shell's settings.open command is invoked
 * through; restated here because dsh-client-shortcuts ships no client types.
 */
export interface ShortcutsRegistryFace {
    invoke(id: string, context: {
        target: unknown;
        region: string;
        modal: string | null;
    }): void;
}
/** The shortcuts service face the apply body hands in, when the host serves it. */
export interface ShortcutsServiceFace {
    registry?: ShortcutsRegistryFace;
}
/** Optional host faces the settings opener consumes; every one may be absent. */
export interface UsageSettingsOpenerFaces {
    /** Shell keyboard command registry; absent when the host predates it. */
    shortcuts?: ShortcutsServiceFace;
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
export declare function openUsageSettings(label: () => string, faces?: UsageSettingsOpenerFaces): void;
/**
 * Mount the sidebar foot card directly above the Settings row.
 * @param props - the store/poll/settings/open inputs of the apply body.
 * @returns disposer removing the container and its observers.
 */
export declare function mountUsageFootCard(props: UsageFootCardProps): () => void;
