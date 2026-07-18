import { Router } from 'express'
import {
  applyOneShotDeploymentCallback,
  OneShotDeploymentError,
  verifyOneShotDeploymentCallbackSecret,
} from '../services/oneshotDeployments.js'
import type { OneShotDeploymentCallbackBody } from '../types/oneshotDeployments.js'

const router = Router()

router.post('/:deploymentId/callback', async (req, res) => {
  try {
    verifyOneShotDeploymentCallbackSecret(req.header('x-oneshot-deploy-secret'))

    const deploymentId = Number(req.params.deploymentId)
    if (!Number.isInteger(deploymentId) || deploymentId <= 0) {
      res.status(400).json({ error: 'deploymentId must be a positive integer' })
      return
    }

    const payload = req.body as Partial<OneShotDeploymentCallbackBody>
    if (!payload.status) {
      res.status(400).json({ error: 'status is required' })
      return
    }

    const deployment = await applyOneShotDeploymentCallback({
      deploymentId,
      payload: payload as OneShotDeploymentCallbackBody,
    })

    res.json({ deployment })
  } catch (error) {
    if (error instanceof OneShotDeploymentError) {
      res.status(error.statusCode).json({ error: error.message })
      return
    }

    console.error('[oneshot-deployments] failed to process callback:', error)
    res.status(500).json({ error: 'Failed to process OneShot deployment callback' })
  }
})

export default router
