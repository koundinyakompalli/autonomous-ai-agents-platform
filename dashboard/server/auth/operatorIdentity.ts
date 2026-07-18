import type { Request } from 'express'
import type { OperatorIdentity } from '../types/oneshotDeployments.js'

export class OperatorIdentityError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
    this.name = 'OperatorIdentityError'
  }
}

function getConfiguredHeaderName(envName: 'DASHBOARD_OPERATOR_ID_HEADER' | 'DASHBOARD_OPERATOR_NAME_HEADER'): string {
  const headerName = process.env[envName]?.trim()
  if (!headerName) {
    throw new OperatorIdentityError(`${envName} is not configured`, 503)
  }
  return headerName
}

function readHeader(req: Request, headerName: string): string | null {
  const value = req.header(headerName)
  return value?.trim() || null
}

export function getTrustedOperatorIdentity(req: Request): OperatorIdentity {
  const operatorIdHeader = getConfiguredHeaderName('DASHBOARD_OPERATOR_ID_HEADER')
  const operatorNameHeader = getConfiguredHeaderName('DASHBOARD_OPERATOR_NAME_HEADER')

  const operatorId = readHeader(req, operatorIdHeader)
  const operatorDisplay = readHeader(req, operatorNameHeader)

  if (!operatorId || !operatorDisplay) {
    throw new OperatorIdentityError('Trusted operator identity headers are missing', 403)
  }

  return {
    id: operatorId,
    display: operatorDisplay,
  }
}

export function hasTrustedOperatorIdentity(req: Request): boolean {
  try {
    getTrustedOperatorIdentity(req)
    return true
  } catch {
    return false
  }
}
