import { Router } from 'express'
import { getTrustedOperatorIdentity, OperatorIdentityError } from '../auth/operatorIdentity.js'
import {
  createOneShotDeploymentRequest,
  OneShotDeploymentError,
} from '../services/oneshotDeployments.js'
import type { CreateOneShotDeploymentRequestBody } from '../types/oneshotDeployments.js'

const router = Router()

router.post('/', async (req, res) => {
  try {
    const operator = getTrustedOperatorIdentity(req)
    const body = req.body as Partial<CreateOneShotDeploymentRequestBody>
    const oneshotRunId = Number(body.oneshotRunId)

    if (!Number.isInteger(oneshotRunId) || oneshotRunId <= 0) {
      res.status(400).json({ error: 'oneshotRunId must be a positive integer' })
      return
    }

    const deployment = await createOneShotDeploymentRequest({
      oneshotRunId,
      operator,
    })

    res.status(201).json({ deployment })
  } catch (error) {
    if (error instanceof OperatorIdentityError || error instanceof OneShotDeploymentError) {
      res.status(error.statusCode).json({ error: error.message })
      return
    }

    console.error('[oneshot-deploy-requests] failed to create deployment request:', error)
    res.status(500).json({ error: 'Failed to create OneShot deployment request' })
  }
})

export default router
