from pydantic import BaseModel, Field


class TokenUpdate(BaseModel):
    theme_slug: str
    path: str = Field(..., description="dotted token path, e.g. color.brand.primary")
    value: str
    type: str | None = None
    note: str | None = None
    designer: str | None = None


class ReportCreate(BaseModel):
    design_version: str | None = None


class ScreenshotCreate(BaseModel):
    component_slug: str
    theme_slug: str
    state: str
    fail_before_step: str | None = None
    resume: bool = False


class ConfirmationCreate(BaseModel):
    component_slug: str
    theme_slug: str
    state: str
    designer: str


class CompareRequest(BaseModel):
    pairs: list[list[str]] = Field(..., description="[[fg,bg], ...]")
    scale: str = "normal"
    purpose: str = "text"


class FreezeVersion(BaseModel):
    version: str
    note: str | None = None
