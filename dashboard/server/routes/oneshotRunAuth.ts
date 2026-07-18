import { Router, type Request, type Response } from 'express'

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

export function startOneShotRunAuth(req: Request, res: Response) {
  const returnTo = sanitizeReturnTo(req.query.returnTo)
  const url = new URL(returnTo, 'https://dashboard.local')
  url.searchParams.set('newRun', '1')

  res.redirect(302, `${url.pathname}${url.search}`)
}

router.get('/start', startOneShotRunAuth)

export default router
