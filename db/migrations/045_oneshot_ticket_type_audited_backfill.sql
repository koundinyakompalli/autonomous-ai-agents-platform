-- Migration 045: exact audited OneShot ticket type backfill for current run-backed tickets.
-- Source: .plan/oneshot-current-run-backed-ticket-types-2026-06-08-refreshed.json

UPDATE oneshot_runs r
JOIN (
  SELECT 'CPDEV-15158' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-15517' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-16027' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-16407' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-16408' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-16410' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-16867' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-18187' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-18878' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-18879' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-18989' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-19042' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-19100' AS jira_key, 'Task' AS jira_issue_type, 'other' AS ticket_type
  UNION ALL SELECT 'CPDEV-19692' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-19784' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-19884' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-20463' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-20626' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-20628' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-20821' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21090' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21145' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21311' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21532' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21533' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21561' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21564' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21571' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21572' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21586' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21690' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-21840' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21841' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21843' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21844' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21845' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21846' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21847' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21898' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21899' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21900' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21901' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21902' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21904' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21905' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21906' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21925' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21926' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21927' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21928' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-21980' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-22045' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-22049' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-22224' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-22229' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-22230' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-22231' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-22232' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-22233' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-22236' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-22308' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-22375' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-22454' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-22517' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-22523' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-22524' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-22525' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-22642' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-22650' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-22651' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-22675' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-22733' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-22739' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-22820' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-22844' AS jira_key, 'Story' AS jira_issue_type, 'security' AS ticket_type
  UNION ALL SELECT 'CPDEV-22853' AS jira_key, 'Story' AS jira_issue_type, 'security' AS ticket_type
  UNION ALL SELECT 'CPDEV-22874' AS jira_key, 'Story' AS jira_issue_type, 'security' AS ticket_type
  UNION ALL SELECT 'CPDEV-22924' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-22962' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-22967' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-23099' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23100' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23113' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23116' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23140' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23148' AS jira_key, 'Task' AS jira_issue_type, 'other' AS ticket_type
  UNION ALL SELECT 'CPDEV-23149' AS jira_key, 'Task' AS jira_issue_type, 'other' AS ticket_type
  UNION ALL SELECT 'CPDEV-23192' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23252' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-23266' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23267' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23269' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23270' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23273' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23274' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23307' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23317' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23326' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23334' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-23335' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-23338' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23339' AS jira_key, 'Sub-task' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23365' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23367' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23378' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23379' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23380' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23381' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23382' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23383' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23384' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23385' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23386' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23387' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23388' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23389' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23390' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23391' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23392' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23393' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23394' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23395' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23396' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23397' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23398' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23399' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23400' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23401' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23402' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23403' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23404' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23405' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23406' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23407' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23408' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23409' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23410' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23411' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23412' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23413' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23414' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23415' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23416' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23417' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23418' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23419' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23420' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23421' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23422' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23423' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23424' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23425' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23426' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23427' AS jira_key, 'Story' AS jira_issue_type, 'sonar' AS ticket_type
  UNION ALL SELECT 'CPDEV-23433' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23435' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23436' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23437' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23486' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23520' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-23548' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23549' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23562' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23563' AS jira_key, 'Story' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23566' AS jira_key, 'Story' AS jira_issue_type, 'security' AS ticket_type
  UNION ALL SELECT 'CPDEV-23567' AS jira_key, 'Story' AS jira_issue_type, 'security' AS ticket_type
  UNION ALL SELECT 'CPDEV-23568' AS jira_key, 'Story' AS jira_issue_type, 'security' AS ticket_type
  UNION ALL SELECT 'CPDEV-23569' AS jira_key, 'Story' AS jira_issue_type, 'security' AS ticket_type
  UNION ALL SELECT 'CPDEV-23570' AS jira_key, 'Story' AS jira_issue_type, 'security' AS ticket_type
  UNION ALL SELECT 'CPDEV-23575' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-23597' AS jira_key, 'Sub-task' AS jira_issue_type, 'other' AS ticket_type
  UNION ALL SELECT 'CPDEV-23599' AS jira_key, 'Sub-task' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23600' AS jira_key, 'Sub-task' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23688' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23693' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-23698' AS jira_key, 'Defect' AS jira_issue_type, 'defect' AS ticket_type
  UNION ALL SELECT 'CPDEV-23699' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23719' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23730' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23734' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23774' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPDEV-23790' AS jira_key, 'Task' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23792' AS jira_key, 'Task' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23793' AS jira_key, 'Sub-task' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23794' AS jira_key, 'Sub-task' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23796' AS jira_key, 'Sub-task' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPDEV-23797' AS jira_key, 'Sub-task' AS jira_issue_type, 'retrofit' AS ticket_type
  UNION ALL SELECT 'CPSR-784' AS jira_key, 'Idea' AS jira_issue_type, 'other' AS ticket_type
  UNION ALL SELECT 'CPSUP-13509' AS jira_key, 'Story' AS jira_issue_type, 'story' AS ticket_type
  UNION ALL SELECT 'CPSUP-33190' AS jira_key, 'Service request' AS jira_issue_type, 'other' AS ticket_type
  UNION ALL SELECT 'CPSUP-43847' AS jira_key, 'Service request' AS jira_issue_type, 'other' AS ticket_type
  UNION ALL SELECT 'CPSUP-46885' AS jira_key, 'Service request' AS jira_issue_type, 'other' AS ticket_type
  UNION ALL SELECT 'CPSUP-47014' AS jira_key, 'Service request' AS jira_issue_type, 'other' AS ticket_type
  UNION ALL SELECT 'CPSUP-47023' AS jira_key, 'Service request' AS jira_issue_type, 'other' AS ticket_type
  UNION ALL SELECT 'CPSUP-49442' AS jira_key, 'Service request' AS jira_issue_type, 'other' AS ticket_type
) audited
  ON audited.jira_key = r.jira_key
SET r.jira_issue_type = CASE
      WHEN audited.jira_issue_type IS NOT NULL THEN audited.jira_issue_type
      ELSE r.jira_issue_type
    END,
    r.ticket_type = audited.ticket_type,
    r.ticket_type_source = 'backfill_audited_jira_snapshot'
WHERE COALESCE(r.ticket_type_source, '') <> 'manual'
  AND r.ticket_type_updated_by IS NULL
  AND r.ticket_type_updated_at IS NULL;
