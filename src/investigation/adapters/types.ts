import type {
  InvestigationAdapterKind,
  InvestigationAdapterRequest,
  InvestigationAdapterResult,
} from '../types/investigation.js'

export interface InvestigationAdapter {
  readonly kind: InvestigationAdapterKind
  execute(request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult>
}

export interface AwsEvidenceAdapter extends InvestigationAdapter {
  readonly kind: 'aws'
}

export interface CodeInspectionAdapterContract extends InvestigationAdapter {
  readonly kind: 'code'
}

export interface DataDiagnosticsAdapter extends InvestigationAdapter {
  readonly kind: 'data'
}

export interface HostInspectionAdapter extends InvestigationAdapter {
  readonly kind: 'host'
}

export interface InvestigationAdapterRegistry {
  aws: AwsEvidenceAdapter
  code: CodeInspectionAdapterContract
  data: DataDiagnosticsAdapter
  host: HostInspectionAdapter
}
