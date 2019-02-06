export enum GameFormat {
    Ranked = 200,
    VersusBot = 201,
    Versus = 202,
    Event = 203,
    Casual = 204,
}

export enum EndCondition {
    Resign = 0,
    Elimination = 1,
    Defeated = 2,
    Repetition = 11,
    Disconnect = 30,
    DoubleDisconnect = 31,
    Draw = 32, // is this some specific type of draw?
}

export enum ReplayCommandType {
    ClickUnit = 'inst clicked',
    ShiftClickUnit = 'inst shift clicked',
    ClickBlueprint = 'card clicked',
    ShiftClickBlueprint = 'card shift clicked',
    ClickSpace = 'space clicked',
    ClickRevert = 'revert clicked',
    ClickUndo = 'undo clicked',
    ClickRedo = 'redo clicked',
    CancelTargeting = 'cancel target processed',
    EndCombinedAction = 'end swipe processed',
    Emote = 'emote',
}

export enum ActionType {
    AssignDefense = 1, // Safety
    CancelAssignDefense,
    EndDefense,
    SelectForTargeting,
    CancelTargeting,
    UseAbility,
    CancelUseAbility,
    Purchase,
    CancelPurchase,
    ProceedToDamage,
    OverrunDefenses,
    CancelOverrunDefenses,
    AssignAttack,
    CancelAssignAttack,
    EndTurn,
    CommitTurn,
    Undo,
    Redo,
    Revert,
}
