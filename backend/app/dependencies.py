from fastapi import Depends

from .config import Settings, get_settings
from .services.expo import ExpoPushService
from .services.supabase import SupabaseDatabase


def get_database(settings: Settings = Depends(get_settings)) -> SupabaseDatabase:
    return SupabaseDatabase(settings)


def get_push_service(settings: Settings = Depends(get_settings)) -> ExpoPushService:
    return ExpoPushService(settings.expo_push_url)
