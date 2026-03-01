import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import routes from './routes'; // Import your routes configuration

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter routes={routes} /> {/* Pass the routes prop here */}
    </StrictMode>
  );
});