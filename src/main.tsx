import "@fontsource-variable/geist"
import "@fontsource-variable/geist-mono"
import "./styles.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import { initAppearance } from "./lib/appearance"

// Before the first render, so a light theme never flashes dark.
initAppearance()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
