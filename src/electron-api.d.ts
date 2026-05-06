import type { TestingToolsApi } from './shared/contracts'

declare global {
  interface Window {
    testingTools?: TestingToolsApi
  }
}

export {}
