#!/usr/bin/env python3
"""
Jira Instance Configuration
Label: Clio - Searches for "Clio" label in New Atlassian Jira
"""
import os
from dotenv import load_dotenv

load_dotenv()

# Define Jira instance
JIRA_INSTANCES = {
    'clio': {
        'label': 'Clio',
        'url': os.getenv('JIRA_URL', 'https://mhkjira.atlassian.net'),
        'username': os.getenv('JIRA_USERNAME', 'rmcdonald@mhk.com'),
        'description': 'New Atlassian Jira - Search label "Clio"',
        'jira_label': os.getenv('JIRA_LABEL', 'Clio')  # Jira label to filter by
    }
}

def get_instance(instance_key='clio'):
    """Get Jira instance configuration by key"""
    return JIRA_INSTANCES.get(instance_key.lower(), JIRA_INSTANCES['clio'])

def get_instance_url(instance_key='clio'):
    """Get Jira URL for instance"""
    return get_instance(instance_key)['url']

def get_instance_username(instance_key='clio'):
    """Get default username for instance"""
    return get_instance(instance_key)['username']

def get_instance_label(instance_key='clio'):
    """Get Jira label to filter by"""
    return get_instance(instance_key).get('jira_label')

def list_instances():
    """List all available instances"""
    return JIRA_INSTANCES

def get_password_env_key(instance_key='clio'):
    """Get the environment variable key for password"""
    return 'JIRA_PASSWORD'
