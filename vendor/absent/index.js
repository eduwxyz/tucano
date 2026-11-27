// An optional package left out of Tucano on purpose (see package.json "overrides"). Softeria's ms-365-mcp-server
// imports @azure/identity and @azure/keyvault-secrets only to read its own settings from an Azure Key Vault,
// which the Microsoft connector never asks it to do; were it asked, this says why it can't.
'use strict'
throw new Error('Tucano does not ship Azure Key Vault support for the Microsoft connector.')
