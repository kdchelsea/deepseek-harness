/** Expandable provider JSON and SSE event inspection with an unchanged text view. */
import { useMemo, useState } from 'react'
import { IconChevronRightOutline14, JsonTree, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonTreeLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LlmResponseBody } from '@deepseek-ai/dsh-llm/types'
import type { TrajectoryTranslate } from './locales.ts'
import { presentResponseBody } from './response-presentation.ts'
import type { ResponseEvent } from './response-presentation.ts'
import css from './TrajectoryTable.module.css'

function EventDetails({ event, index, t, labels }: {
  event: ResponseEvent
  index: number
  t: TrajectoryTranslate
  labels: JsonTreeLabels
}) {
  const [open, setOpen] = useState(false)
  const label = t('rawResponse.event', { index: index + 1, name: event.name })
  return <details className={css.responseEvent} onToggle={(e) => { setOpen(e.currentTarget.open) }}>
    <summary className={css.responseEventSummary}>
      <IconChevronRightOutline14 className={css.toolCatalogChevron} size={12} />
      <span>{label}</span>
    </summary>
    {open && <>
      {event.id !== undefined && <p className={css.noPayload}>{t('rawResponse.eventId', { id: event.id })}</p>}
      <JsonTree data={event.data} label={label} labels={labels} className={css.jsonPayload} />
    </>}
  </details>
}

/**
 * Display a captured response as expandable data or exact original text.
 * @param props - saved response and locale-owned presentation labels.
 * @returns one response inspector with lazily mounted SSE event trees.
 */
export function ResponseBodyView({ response, t, labels }: {
  response: LlmResponseBody
  t: TrajectoryTranslate
  labels: JsonTreeLabels
}) {
  const [raw, setRaw] = useState(false)
  const view = useMemo(() => presentResponseBody(response.body, response.contentType), [response.body, response.contentType])
  return <>
    <div className={css.responseToolbar}>
      <Pill aria-pressed={!raw} active={!raw} onClick={() => { setRaw(false) }}>{t('rawResponse.structured')}</Pill>
      <Pill aria-pressed={raw} active={raw} onClick={() => { setRaw(true) }}>{t('rawResponse.original')}</Pill>
      {!raw && view.kind === 'sse' && <span className={css.sourceBlockLabel}>{t('rawResponse.eventCount', { count: view.events.length })}</span>}
    </div>
    {raw || view.kind === 'text'
      ? <pre className={css.sourceBlockContent}>{response.body}</pre>
      : view.kind === 'json'
        ? <JsonTree data={view.data} label={t('rawResponse.json')} labels={labels} className={css.jsonPayload} />
        : <>
          <p className={css.noPayload}>{t('rawResponse.sseHint')}</p>
          {view.events.map((event, index) => <EventDetails key={index} event={event} index={index} t={t} labels={labels} />)}
        </>}
  </>
}
