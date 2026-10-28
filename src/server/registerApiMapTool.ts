import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { ApiMapService } from "../application/ApiMapService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { redactExplicitFailure } from "../domain/explicitSensitiveFailure.js";
import { captureSensitiveValues } from "../domain/webNetworkCapture.js";
import { err } from "../domain/result.js";
import {
  toolRegistrationOptions,
  applicationValidatedInputSchema,
} from "./toolRegistrationOptions.js";

/** Bind the one-shot capture-to-API-map workflow to its named contract. */
export const registerApiMapTool = (
  server: EvidenceMcpServer,
  service: ApiMapService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("map_api");
  const registration = toolRegistrationOptions(contract);
  // Keep the exact advertised contract; the shared service validates raw input
  // before effects so caller-declared sensitivity also covers invalid arguments.
  const inputSchema = applicationValidatedInputSchema(registration.inputSchema);
  const handler = createEvidenceToolHandler(
    server,
    async (rawInput, options) => {
      const parsed = contract.inputSchema.safeParse(rawInput);
      if (!parsed.success)
        return err(
          redactExplicitFailure(
            analysisInputErrorFromIssues(
              contract.name,
              parsed.error.issues,
              rawInput,
              { cause: parsed.error },
            ),
            captureSensitiveValues(rawInput),
          ),
        );
      return service.map(parsed.data, options);
    },
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    { ...registration, inputSchema },
    handler(contract),
  );
};
