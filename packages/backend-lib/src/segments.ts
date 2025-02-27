import { writeToString } from "@fast-csv/format";
import { ValueError } from "@sinclair/typebox/errors";
import { format } from "date-fns";
import { CHANNEL_IDENTIFIERS } from "isomorphic-lib/src/channels";
import {
  schemaValidate,
  schemaValidateWithErr,
} from "isomorphic-lib/src/resultHandling/schemaValidation";
import { err, ok, Result } from "neverthrow";

import logger from "./logger";
import prisma from "./prisma";
import {
  EnrichedSegment,
  InternalEventType,
  Prisma,
  Segment,
  SegmentAssignment,
  SegmentDefinition,
  SegmentNode,
  SegmentNodeType,
  SegmentResource,
  UpsertSegmentResource,
} from "./types";

export function enrichSegment(
  segment: Segment
): Result<EnrichedSegment, Error> {
  const definitionResult = schemaValidateWithErr(
    segment.definition,
    SegmentDefinition
  );
  if (definitionResult.isErr()) {
    return err(definitionResult.error);
  }
  return ok({
    ...segment,
    definition: definitionResult.value,
  });
}

export async function createSegment({
  name,
  definition,
  workspaceId,
}: {
  name: string;
  workspaceId: string;
  definition: SegmentDefinition;
}) {
  await prisma().segment.create({
    data: {
      workspaceId,
      name,
      definition,
    },
  });
}

export function toSegmentResource(
  segment: Segment
): Result<SegmentResource, Error> {
  const result = enrichSegment(segment);
  if (result.isErr()) {
    return err(result.error);
  }
  const { id, name, workspaceId, definition, subscriptionGroupId } =
    result.value;
  return ok({
    id,
    name,
    workspaceId,
    definition,
    subscriptionGroupId: subscriptionGroupId ?? undefined,
  });
}

export async function findEnrichedSegment(
  segmentId: string
): Promise<Result<EnrichedSegment | null, Error>> {
  const segment = await prisma().segment.findFirst({
    where: { id: segmentId },
  });
  if (!segment) {
    return ok(null);
  }

  return enrichSegment(segment);
}

export async function findEnrichedSegments({
  workspaceId,
  ids,
}: {
  workspaceId: string;
  ids?: string[];
}): Promise<Result<EnrichedSegment[], Error>> {
  const where: Prisma.SegmentWhereInput = {
    workspaceId,
  };
  if (ids) {
    where.id = {
      in: ids,
    };
  }
  const segments = await prisma().segment.findMany({
    where,
  });

  const enrichedSegments: EnrichedSegment[] = [];
  for (const segment of segments) {
    const definitionResult = schemaValidateWithErr(
      segment.definition,
      SegmentDefinition
    );
    if (definitionResult.isErr()) {
      return err(definitionResult.error);
    }
    enrichedSegments.push({
      ...segment,
      definition: definitionResult.value,
    });
  }
  return ok(enrichedSegments);
}

export async function findManyEnrichedSegments({
  workspaceId,
  segmentIds,
  requireRunning = true,
}: {
  workspaceId: string;
  segmentIds?: string[];
  requireRunning?: boolean;
}): Promise<Result<EnrichedSegment[], ValueError[]>> {
  const segments = await prisma().segment.findMany({
    where: {
      workspaceId,
      ...(segmentIds?.length
        ? {
            id: {
              in: segmentIds,
            },
          }
        : null),
      ...(requireRunning && !segmentIds?.length
        ? {
            status: "Running",
          }
        : null),
    },
  });

  const enrichedSegments: EnrichedSegment[] = [];
  for (const segment of segments) {
    const definitionResult = schemaValidate(
      segment.definition,
      SegmentDefinition
    );
    if (definitionResult.isErr()) {
      return err(definitionResult.error);
    }
    enrichedSegments.push({
      ...segment,
      definition: definitionResult.value,
    });
  }
  return ok(enrichedSegments);
}

/**
 * Upsert segment resource if the existing segment is not internal.
 * @param segment
 * @returns
 */
export async function upsertSegment(
  segment: UpsertSegmentResource
): Promise<SegmentResource> {
  const { id, workspaceId, name, definition } = segment;
  const query = Prisma.sql`
    INSERT INTO "Segment" ("id", "workspaceId", "name", "definition", "updatedAt")
    VALUES (${id}::uuid, ${workspaceId}::uuid, ${name}, ${definition}::jsonb, NOW())
    ON CONFLICT ("id")
    DO UPDATE SET
        "workspaceId" = excluded."workspaceId",
        "name" = COALESCE(excluded."name", "Segment"."name"),
        "definition" = COALESCE(excluded."definition", "Segment"."definition"),
        "updatedAt" = NOW()
    RETURNING *`;
  const [result] = (await prisma().$queryRaw(query)) as [Segment];
  const updatedDefinition = result.definition as SegmentDefinition;

  return {
    id: result.id,
    workspaceId: result.workspaceId,
    name: result.name,
    definition: updatedDefinition,
  };
}

export function segmentNodeIsBroadcast(node: SegmentNode): boolean {
  return (
    node.type === SegmentNodeType.Broadcast ||
    (node.type === SegmentNodeType.Performed &&
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
      node.event === InternalEventType.SegmentBroadcast)
  );
}

export function segmentHasBroadcast(definition: SegmentDefinition): boolean {
  if (segmentNodeIsBroadcast(definition.entryNode)) {
    return true;
  }

  for (const node of definition.nodes) {
    if (segmentNodeIsBroadcast(node)) {
      return true;
    }
  }
  return false;
}

const downloadCsvHeaders = [
  "segmentName",
  "segmentId",
  "userId",
  "inSegment",
  "subscriptionGroupName",
];

// TODO use pagination, and blob store
export async function buildSegmentsFile({
  workspaceId,
}: {
  workspaceId: string;
}): Promise<{
  fileName: string;
  fileContent: string;
}> {
  const identifiers = Object.values(CHANNEL_IDENTIFIERS);
  const [dbSegmentAssignments, userIdentifiers] = await Promise.all([
    prisma().segmentAssignment.findMany({
      where: { workspaceId },
      include: {
        segment: {
          select: {
            name: true,
            subscriptionGroup: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    }),
    prisma().userPropertyAssignment.findMany({
      where: {
        workspaceId,
        userProperty: {
          name: {
            in: identifiers,
          },
        },
      },
      select: {
        userProperty: {
          select: {
            name: true,
          },
        },
        userId: true,
        value: true,
      },
    }),
  ]);
  const userIdentifiersMap = userIdentifiers.reduce((acc, curr) => {
    const userPropertyName = curr.userProperty.name;
    const ui = acc.get(curr.userId) ?? new Map<string, string>();
    ui.set(userPropertyName, curr.value);
    acc.set(curr.userId, ui);
    return acc;
  }, new Map<string, Map<string, string>>());

  const assignments: Record<string, string>[] = dbSegmentAssignments.map(
    (a) => {
      const csvAssignment: Record<string, string> = {
        segmentName: a.segment.name,
        subscriptionGroupName: a.segment.subscriptionGroup?.name ?? "",
        segmentId: a.segmentId,
        userId: a.userId,
        inSegment: a.inSegment.toString(),
      };
      const ui = userIdentifiersMap.get(a.userId);
      ui?.forEach((value, key) => {
        const parsed = JSON.parse(value);
        if (typeof parsed === "string" && parsed.length > 0) {
          csvAssignment[key] = parsed;
        }
      });
      return csvAssignment;
    }
  );
  const fileContent = await writeToString(assignments, {
    headers: [...downloadCsvHeaders, ...identifiers],
  });

  const formattedDate = format(new Date(), "yyyy-MM-dd");
  const fileName = `segment-assignments-${formattedDate}.csv`;

  return {
    fileName,
    fileContent,
  };
}

export type SegmentBulkUpsertItem = Pick<
  SegmentAssignment,
  "workspaceId" | "userId" | "segmentId" | "inSegment"
>;

export async function upsertBulkSegmentAssignments({
  data,
}: {
  data: SegmentBulkUpsertItem[];
}) {
  if (data.length === 0) {
    return;
  }
  const existing = new Map<string, SegmentBulkUpsertItem>();
  for (const item of data) {
    const key = `${item.workspaceId}-${item.segmentId}-${item.userId}`;
    if (existing.has(key)) {
      logger().warn(
        {
          existing: existing.get(key),
          new: item,
          workspaceId: item.workspaceId,
        },
        "duplicate segment assignment in bulk upsert"
      );
      continue;
    }
    existing.set(key, item);
  }
  const deduped = Array.from(existing.values());
  const workspaceIds: Prisma.Sql[] = [];
  const userIds: string[] = [];
  const segmentIds: Prisma.Sql[] = [];
  const inSegment: boolean[] = [];

  for (const item of deduped) {
    workspaceIds.push(Prisma.sql`CAST(${item.workspaceId} AS UUID)`);
    userIds.push(item.userId);
    segmentIds.push(Prisma.sql`CAST(${item.segmentId} AS UUID)`);
    inSegment.push(item.inSegment);
  }

  const query = Prisma.sql`
    INSERT INTO "SegmentAssignment" ("workspaceId", "userId", "segmentId", "inSegment")
    SELECT
      unnest(array[${Prisma.join(workspaceIds)}]),
      unnest(array[${Prisma.join(userIds)}]),
      unnest(array[${Prisma.join(segmentIds)}]),
      unnest(array[${Prisma.join(inSegment)}])
    ON CONFLICT ("workspaceId", "userId", "segmentId")
    DO UPDATE SET
      "inSegment" = EXCLUDED."inSegment"
  `;

  try {
    await prisma().$executeRaw(query);
  } catch (e) {
    if (
      !(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003")
    ) {
      throw e;
    }
  }
}
