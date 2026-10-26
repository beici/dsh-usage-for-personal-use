/**
 * The multi-device card: which ledger files back the totals above, plus the
 * manual export/import that moves one device's history to another.
 *
 * The design the card exposes is deliberately boring: there is no merge policy
 * to explain, because each machine owns exactly one file and the totals are a
 * sum over the files present. Export hands over this device's file; import
 * installs a peer's file under that peer's id. Neither direction can overwrite
 * the local history, so a round trip is safe to repeat.
 * @module @linxin666/dsh-usage/client/DeviceSyncCard
 */

import { useRef, useState, type ReactNode } from 'react'
import { t } from './locales.ts'
import { describeError } from './error-text.ts'
import styles from './usage.module.css'
import type { DeviceLedgerEntryView } from '../core/types.ts'

/** The host half's device-sync API, as the browser half addresses it. */
export interface DeviceSyncApi {
  /** Download this device's ledger as a file. */
  exportLedger: () => Promise<void>
  /** Install a peer's exported ledger; resolves with that peer's device id. */
  importLedger: (text: string) => Promise<{ deviceId: string }>
  /** Re-scan the persist directory for files dropped in by hand. */
  rescan: () => Promise<DeviceLedgerEntryView[]>
}

/**
 * One status line under the controls. `tone` only picks the CSS class, so an
 * import failure is visible without inventing a second message slot.
 */
interface Notice {
  text: string
  tone: 'ok' | 'error'
}

/**
 * The multi-device card. Device rows are the source list, not a picker: a peer
 * file is removed by deleting it from the DSH data directory, which the hint
 * says — an in-panel delete would need a confirmation surface the section has
 * nowhere to put.
 * @param props - the devices the overview reported, the sync API, and an optional read error.
 * @returns the card, or nothing when an older host serves no device list.
 */
export function DeviceSyncCard(props: {
  deviceId?: string
  devices?: DeviceLedgerEntryView[]
  devicesError?: string
  /** Absent on an older host face; the card then renders nothing. */
  api?: DeviceSyncApi
  /** Called after an import so the section can refetch the summed overview. */
  onChanged: () => void
}): ReactNode {
  const { deviceId, devices, devicesError, api, onChanged } = props
  const [busy, setBusy] = useState<'export' | 'import' | 'rescan' | undefined>(undefined)
  const [notice, setNotice] = useState<Notice | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  // An older host serves no device list (and no sync API); the card would be a
  // dead control there, so it renders nothing instead of an empty shell.
  if (devices === undefined || api === undefined) return undefined

  // Each action names itself in both directions: one shared "import failed" for
  // all three told a user whose export broke that the file they never imported
  // was at fault, and a success notice that repeats the button label reads as a
  // prompt rather than as an answer.
  const run = async (kind: 'export' | 'import' | 'rescan', action: () => Promise<Notice>): Promise<void> => {
    setBusy(kind)
    setNotice(undefined)
    try {
      setNotice(await action())
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const key = kind === 'export'
        ? 'usage.device.exportFailed'
        : kind === 'rescan' ? 'usage.device.rescanFailed' : 'usage.device.importFailed'
      setNotice({ text: t(key, { error: detail }), tone: 'error' })
    } finally {
      setBusy(undefined)
    }
  }

  const onExport = (): void => {
    void run('export', async () => {
      await api.exportLedger()
      return { text: t('usage.device.exported'), tone: 'ok' }
    })
  }

  const onFile = (file: File | undefined): void => {
    if (file === undefined) return
    void run('import', async () => {
      const text = await file.text()
      const result = await api.importLedger(text)
      onChanged()
      return { text: t('usage.device.imported', { deviceId: result.deviceId }), tone: 'ok' }
    })
  }

  const onRescan = (): void => {
    void run('rescan', async () => {
      await api.rescan()
      onChanged()
      return { text: t('usage.device.rescanned'), tone: 'ok' }
    })
  }

  const copyId = (): void => {
    if (deviceId === undefined) return
    void navigator.clipboard?.writeText(deviceId).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1_500)
      },
      () => setCopied(false),
    )
  }

  return (
    <div className={styles.card} data-dsh-part="device-card">
      <span className={styles.cardTitle}>{t('usage.device.title')}</span>
      <span className={styles.muted}>{t('usage.device.hint')}</span>
      {devices.length <= 1 && <span className={styles.muted} data-dsh-part="device-none">{t('usage.device.none')}</span>}
      {devices.map((device) => (
        <div className={styles.providerRow} key={`${device.role}:${device.deviceId}`} data-dsh-part="device-row">
          <span className={styles.providerName}>
            {device.role === 'local' ? t('usage.device.local') : t('usage.device.peer')}
            <span className={styles.muted} style={{ marginLeft: 8 }}>{device.deviceId}</span>
          </span>
        </div>
      ))}
      {devicesError !== undefined && (
        // The sentence is translated; the raw read error (a path, an errno) stays
        // in the title, where a diagnostic belongs.
        <span className={styles.errorLine} role="status" data-dsh-part="device-error" title={devicesError}>
          {t('usage.device.error', { error: describeError(devicesError, 'usage.error.readFailed') })}
        </span>
      )}
      <div className={styles.rangeControls} style={{ marginTop: 8 }}>
        <button type="button" className={styles.refreshBtn} onClick={onExport} disabled={busy !== undefined}>
          {t('usage.device.export')}
        </button>
        <button type="button" className={styles.refreshBtn} onClick={() => fileRef.current?.click()} disabled={busy !== undefined}>
          {busy === 'import' ? t('usage.device.importing') : t('usage.device.import')}
        </button>
        <button type="button" className={styles.refreshBtn} onClick={onRescan} disabled={busy !== undefined}>
          {t('usage.device.rescan')}
        </button>
        {deviceId !== undefined && (
          <button type="button" className={styles.refreshBtn} onClick={copyId}>
            {copied ? t('usage.device.copied') : t('usage.device.copyId')}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            onFile(file)
          }}
        />
      </div>
      {notice !== undefined && (
        <span className={notice.tone === 'error' ? styles.errorLine : styles.muted} role="status" data-dsh-part="device-notice">
          {notice.text}
        </span>
      )}
      <span className={styles.muted}>{t('usage.device.dropHint')}</span>
    </div>
  )
}
