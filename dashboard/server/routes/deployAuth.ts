import { Router } from 'express'

const router = Router()

function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return '/oneshot'
  }

  const trimmed = value.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return '/oneshot'
  }

  return trimmed
}

router.get('/start', (req, res) => {
  const oneshotRunId = Number(req.query.oneshotRunId)
  if (!Number.isInteger(oneshotRunId) || oneshotRunId <= 0) {
    res.status(400).send('oneshotRunId must be a positive integer')
    return
  }

  const returnTo = sanitizeReturnTo(req.query.returnTo)
  const url = new URL(returnTo, 'https://dashboard.local')
  url.searchParams.set('deployAfter', String(oneshotRunId))
  url.searchParams.set('deployAuth', '1')

  res.redirect(302, `${url.pathname}${url.search}`)
})

export default router
