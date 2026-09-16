import type {
  CoverDeviceAttributes,
  CoverDeviceState,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { Agent } from "@matter/main";
import {
  ClosureControlServer as BaseClosureControlServer,
  ClosureDimensionServer as BaseClosureDimensionServer,
} from "@matter/main/behaviors";
import { ClosureControl, ClosureDimension } from "@matter/main/clusters";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";

const logger = Logger.get("CoverClosureServer");

const ClosureControlBase = BaseClosureControlServer.with("Positioning");
const ClosureDimensionBase = BaseClosureDimensionServer.with(
  "Positioning",
  "Translation",
);

const CLOSED_PERCENT_100THS = 10_000;
const OPEN_PERCENT_100THS = 0;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function attributes(
  entity: HomeAssistantEntityInformation,
): CoverDeviceAttributes {
  return entity.state.attributes as CoverDeviceAttributes;
}

function closurePercentFromHa(
  entity: HomeAssistantEntityInformation,
): number | null {
  const current = attributes(entity).current_position;
  if (typeof current === "number" && Number.isFinite(current)) {
    // HA cover semantics: 0 = closed, 100 = open.
    // Matter Closure Dimension convention: 0 = open, 10000 = closed.
    return clamp(Math.round((100 - current) * 100), 0, 10_000);
  }

  switch (entity.state.state as CoverDeviceState) {
    case "closed":
      return CLOSED_PERCENT_100THS;
    case "open":
      return OPEN_PERCENT_100THS;
    default:
      return null;
  }
}

function haPositionFromClosurePercent(position: number): number {
  return clamp(Math.round(100 - clamp(position, 0, 10_000) / 100), 0, 100);
}

function currentPositionFromHa(
  entity: HomeAssistantEntityInformation,
): ClosureControl.CurrentPosition | null {
  const closurePercent = closurePercentFromHa(entity);
  if (closurePercent == null) return null;
  if (closurePercent <= OPEN_PERCENT_100THS) {
    return ClosureControl.CurrentPosition.FullyOpened;
  }
  if (closurePercent >= CLOSED_PERCENT_100THS) {
    return ClosureControl.CurrentPosition.FullyClosed;
  }
  return ClosureControl.CurrentPosition.PartiallyOpened;
}

function mainStateFromHa(
  entity: HomeAssistantEntityInformation,
): ClosureControl.MainState {
  switch (entity.state.state as CoverDeviceState) {
    case "opening":
    case "closing":
      return ClosureControl.MainState.Moving;
    default:
      return ClosureControl.MainState.Stopped;
  }
}

function secureStateFromHa(
  entity: HomeAssistantEntityInformation,
): boolean | null {
  const position = currentPositionFromHa(entity);
  if (position == null) return null;
  return position === ClosureControl.CurrentPosition.FullyClosed;
}

function callSetPosition(agent: Agent, position: number) {
  const homeAssistant = agent.get(HomeAssistantEntityBehavior);
  const haPosition = haPositionFromClosurePercent(position);
  logger.info(
    `[${homeAssistant.entityId}] Moving closure to ${position} (${haPosition}% HA open)`,
  );
  homeAssistant.callAction({
    action: "cover.set_cover_position",
    data: { position: haPosition },
  });
}

export class ClosureControlServer extends ClosureControlBase {
  declare state: ClosureControlServer.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    const position = currentPositionFromHa(entity);
    applyPatchState(this.state, {
      mainState: mainStateFromHa(entity),
      countdownTime: null,
      currentErrorList: [],
      overallCurrentState: {
        position,
        secureState: secureStateFromHa(entity),
      },
      overallTargetState: null,
    });
  }

  override moveTo(request: ClosureControl.MoveToRequest) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    switch (request.position) {
      case ClosureControl.TargetPosition.MoveToFullyOpen:
        logger.info(`[${homeAssistant.entityId}] Opening closure`);
        homeAssistant.callAction({ action: "cover.open_cover" });
        return;
      case ClosureControl.TargetPosition.MoveToFullyClosed:
        logger.info(`[${homeAssistant.entityId}] Closing closure`);
        homeAssistant.callAction({ action: "cover.close_cover" });
        return;
      default:
        return;
    }
  }

  override stop() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    logger.info(`[${homeAssistant.entityId}] Stopping closure`);
    homeAssistant.callAction({ action: "cover.stop_cover" });
    applyPatchState(this.state, {
      mainState: ClosureControl.MainState.Stopped,
      overallTargetState: null,
    });
  }
}

export namespace ClosureControlServer {
  export class State extends ClosureControlBase.State {}
}

export class ClosureDimensionServer extends ClosureDimensionBase {
  declare state: ClosureDimensionServer.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    const position = closurePercentFromHa(entity);
    applyPatchState(this.state, {
      currentState: position == null ? null : { position },
      targetState: null,
      resolution: 100,
      stepValue: 1_000,
      translationDirection: ClosureDimension.TranslationDirection.Upward,
    });
  }

  override setTarget(request: ClosureDimension.SetTargetRequest) {
    if (typeof request.position !== "number") return;
    const position = clamp(request.position, 0, 10_000);
    applyPatchState(this.state, {
      targetState: { position },
    });
    callSetPosition(this.agent, position);
  }

  override step(request: ClosureDimension.StepRequest) {
    const current = this.state.currentState?.position ?? CLOSED_PERCENT_100THS;
    const direction = request.direction;
    const delta = this.state.stepValue * request.numberOfSteps;
    const target =
      direction === ClosureDimension.StepDirection.Increase
        ? current + delta
        : current - delta;
    this.setTarget({ position: clamp(target, 0, 10_000) });
  }
}

export namespace ClosureDimensionServer {
  export class State extends ClosureDimensionBase.State {}
}
