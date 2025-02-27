import {
  IntegrationCreateDefinition,
  IntegrationType,
  SegmentDefinition,
  SegmentNodeType,
  SegmentOperatorType,
} from "./types";

export const HUBSPOT_OAUTH_TOKEN = "hubspot" as const;
export const HUBSPOT_INTEGRATION = "hubspot" as const;
export const EMAIL_EVENTS_UP_NAME = "DFEmailEvents" as const;

export const HUBSPOT_INTEGRATION_DEFINITION: IntegrationCreateDefinition = {
  name: HUBSPOT_INTEGRATION,
  definition: {
    type: IntegrationType.Sync,
    subscribedUserProperties: [EMAIL_EVENTS_UP_NAME],
    subscribedSegments: [],
  },
};

const ENTRY_ID = "entry";
const INIT_TRAIT_ID = "initTraitId";

export const DEFAULT_SEGMENT_DEFINITION: SegmentDefinition = {
  entryNode: {
    type: SegmentNodeType.And,
    children: [INIT_TRAIT_ID],
    id: ENTRY_ID,
  },
  nodes: [
    {
      type: SegmentNodeType.Trait,
      id: INIT_TRAIT_ID,
      path: "",
      operator: {
        type: SegmentOperatorType.Equals,
        value: "",
      },
    },
  ],
};
