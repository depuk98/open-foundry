{{/*
Expand the name of the chart.
*/}}
{{- define "openfoundry.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "openfoundry.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "openfoundry.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "openfoundry.labels" -}}
helm.sh/chart: {{ include "openfoundry.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: openfoundry
{{- end }}

{{/*
Selector labels for a specific component.
*/}}
{{- define "openfoundry.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .release }}
{{- end }}

{{/*
PostgreSQL connection URL.
*/}}
{{- define "openfoundry.postgresUrl" -}}
postgresql://$(POSTGRES_USERNAME):$(POSTGRES_PASSWORD)@{{ .Values.storage.postgres.host }}:{{ .Values.storage.postgres.port }}/{{ .Values.storage.postgres.database }}
{{- end }}

{{/*
Service account name.
HELM-14: Explicit service account for all deployments.
*/}}
{{- define "openfoundry.serviceAccountName" -}}
{{- if .Values.serviceAccount }}
{{- .Values.serviceAccount.name | default "" }}
{{- end }}
{{- end }}

{{/*
Image reference for a service.
*/}}
{{- define "openfoundry.image" -}}
{{- $tag := default .global.tag .svc.tag -}}
{{- if .svc.repository -}}
{{ .svc.repository }}:{{ $tag }}
{{- else -}}
{{ .global.registry }}/{{ .name }}:{{ $tag }}
{{- end -}}
{{- end }}
