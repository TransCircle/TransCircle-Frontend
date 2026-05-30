// Unified response helpers matching apidocs.md §12

import { requestId } from './_ulid'

function generateRequestId(): string {
  return requestId()
}

export function successResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, requestId: generateRequestId() }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
  details?: { field: string; reason: string }[],
): Response {
  const error: { code: string; message: string; details?: { field: string; reason: string }[] } = {
    code,
    message,
  }
  if (details) error.details = details
  return new Response(JSON.stringify({ error, requestId: generateRequestId() }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
