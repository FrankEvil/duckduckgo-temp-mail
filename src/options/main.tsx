import React from "react";
import ReactDOM from "react-dom/client";

import { OptionsApp } from "./OptionsApp";
import "../shared/styles/global.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <OptionsApp />
  </React.StrictMode>
);
