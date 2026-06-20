# max2ntfy

Docker-мост из веб-версии MAX в локальный `ntfy`.

Проект основан на оригинальном репозитории:
https://github.com/ilcommm/Max2iMessage

Оригинал был macOS-приложением для отправки уведомлений в iMessage. Этот вариант оставляет только Docker-часть: Playwright открывает `web.max.ru`, ловит новые сообщения и отправляет их в `ntfy`.

## Как устанавливать

Установка сделана как у обычных Docker-проектов:

1. Создать папки.
2. Вставить `docker-compose.yml` в Synology Container Manager / Portainer.
3. Поменять несколько строк под себя.
4. Запустить стек.

Скачивать исходники на NAS не нужно.


## Папки на NAS

Пример:

```text
/volume1/docker/max2ntfy
├── accounts
│   └── user
└── ntfy
    └── cache
```

В `docker-compose.yml` уже прописаны эти пути:

```yaml
/volume1/docker/max2ntfy/ntfy/cache:/var/cache/ntfy:rw
/volume1/docker/max2ntfy/accounts/user:/data:rw
```

Если у вас не Synology или другой путь хранения Docker, замените `/volume1/docker/max2ntfy` на свой путь.

## Что поменять в docker-compose.yml

Минимум:

```yaml
image: ghcr.io/your-github-login/max2ntfy:latest
NTFY_BASE_URL: https://ntfy.example.com
TARGET_PASSWORD: CHANGE_ME_BRIDGE_PASSWORD
TARGET_URL: http://ntfy/max_user
ACCOUNT_NAME: user
```

Где:

- `NTFY_BASE_URL` - ваш публичный адрес ntfy
- `TARGET_PASSWORD` - пароль пользователя `maxbridge`
- `TARGET_URL` - topic ntfy, например `http://ntfy/max_user`
- `ACCOUNT_NAME` - имя аккаунта MAX внутри контейнера

## Первый запуск

После запуска откройте:

```text
http://NAS_IP:3010/login.png
```

Там будет экран входа MAX.

Проверка статуса:

```text
http://NAS_IP:3010/healthz
```

Нормально, если после входа видно:

```json
{
  "running": true,
  "authState": "authenticated",
  "monitorReady": true
}
```

## Настройка пользователей ntfy

В SSH на NAS:

```bash
docker exec -it max2ntfy-ntfy-1 ntfy user add user
docker exec -it max2ntfy-ntfy-1 ntfy user add maxbridge
docker exec -it max2ntfy-ntfy-1 ntfy access user max_user read-write
docker exec -it max2ntfy-ntfy-1 ntfy access maxbridge max_user write-only
docker exec -it max2ntfy-ntfy-1 ntfy access
```

Пароль `maxbridge` должен совпадать с `TARGET_PASSWORD` в `docker-compose.yml`.

## iPhone

В приложении `ntfy`:

- server: `https://ntfy.example.com`
- username: `user`
- topic: `max_user`

Для iOS push нужен параметр:

```yaml
NTFY_UPSTREAM_BASE_URL: https://ntfy.sh
```

Текст сообщений через `ntfy.sh` не передается. Он используется для пробуждения iOS-приложения, а реальные уведомления iPhone забирает с вашего сервера.

## Фильтры

Включены по умолчанию:

```yaml
SKIP_OWN_MESSAGES: "true"
SKIP_MUTED_CHATS: "true"
```

- свои сообщения не отправляются в ntfy
- чаты с отключенными уведомлениями не отправляются в ntfy, если MAX передал признак muted-чата
