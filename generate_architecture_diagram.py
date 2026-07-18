#!/usr/bin/env python3
"""
Generate Specter Architecture Diagram using Python Diagrams library.
Install: pip install diagrams
"""

from diagrams import Diagram, Cluster, Edge
from diagrams.aws.compute import ECS
from diagrams.aws.database import RDS
from diagrams.aws.storage import S3, EFS
from diagrams.onprem.client import Users
from diagrams.onprem.vcs import Git
from diagrams.custom import Custom
from diagrams.programming.framework import React

# Create the diagram
with Diagram("Specter Architecture", 
             filename="specter_architecture",
             show=False,
             direction="TB",
             graph_attr={
                 "bgcolor": "transparent",
                 "fontsize": "14",
                 "fontname": "Helvetica",
                 "pad": "0.5",
             }):
    
    # JIRA Cloud (top level)
    jira = Custom("JIRA Cloud\n(Tickets with Agent Labels)", "./jira_icon.png") if False else Users("JIRA Cloud\nTickets")
    
    # Orchestrator Service
    with Cluster("ECS Cluster - Orchestrator"):
        orchestrator = ECS("Orchestrator Service\n• Polls JIRA every 60s\n• Assigns to agents\n• Posts results back")
    
    # Database
    database = RDS("MySQL Database\n• agents\n• task_management\n• tasks\n• code_repositories")
    
    # Worker Services
    with Cluster("ECS Cluster - Agent Workers"):
        darci = ECS("DARCI Worker\n(x2 instances)\nDefect Analysis")
        scribe = ECS("SCRIBE Worker\n(x1 instance)\nDocumentation")
        prism = ECS("PRISM Worker\n(x1 instance)\nPlanning")
        hermes = ECS("HERMES Worker\n(x1 instance)\nConfig Lookup")
        sentry = ECS("SENTRY Worker\n(x1 instance)\nSQL Review")
    
    # Storage
    with Cluster("AWS Storage"):
        s3_tasks = S3("S3: specter-tasks\nTask descriptions")
        s3_results = S3("S3: specter-results\nAgent outputs")
        efs = EFS("EFS: Shared Volume\nCode repositories")
    
    # Git Repositories
    repos = Git("Code Repositories\n(Cloned to EFS)")
    
    # Define connections
    jira >> Edge(label="JQL Queries\nevery 60s") >> orchestrator
    orchestrator >> Edge(label="Write tasks") >> database
    orchestrator >> Edge(label="Upload tasks") >> s3_tasks
    orchestrator >> Edge(label="Post results") >> jira
    
    database >> Edge(label="Poll for work\nevery 10s") >> [darci, scribe, prism, hermes, sentry]
    
    s3_tasks >> Edge(label="Download tasks") >> [darci, scribe, prism, hermes, sentry]
    [darci, scribe, prism, hermes, sentry] >> Edge(label="Upload results") >> s3_results
    
    efs >> Edge(label="Read code") >> [darci, scribe, prism, hermes, sentry]
    repos >> Edge(label="Sync") >> efs
    
    s3_results >> Edge(label="Read results\nevery 30s") >> orchestrator

print("✅ Architecture diagram generated successfully!")
print("📁 Output file: specter_architecture.png")
