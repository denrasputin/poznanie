# Внешний «будильник»: сбор ровно раз в час

Встроенное расписание GitHub работает «как получится»: при нагрузке запуски сдвигаются на часы или пропадают
(в первые сутки было 5 запусков вместо 16). А ручной запуск сбора (кнопка «Run workflow») срабатывает сразу.
Его можно «нажимать» запросом через интернет — этим и займётся бесплатный сервис cron-job.org.

## 1. Ключ на GitHub (5 минут)

1. GitHub → аватар → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Token name:** `poznanie-alarm`. **Expiration:** например, 1 год (потом ключ нужно будет заменить).
3. **Repository access:** *Only select repositories* → `poznanie`.
4. **Permissions → Repository permissions → Actions:** *Read and write*. Остальное не трогайте.
5. **Generate token** и скопируйте ключ (`github_pat_…`). Он показывается один раз.

Права у ключа узкие: им можно только запускать и останавливать сценарии этого репозитория, менять код нельзя.

## 2. Задание на cron-job.org

1. Зарегистрируйтесь на <https://cron-job.org> и нажмите **Create cronjob**.
2. **URL:** `https://api.github.com/repos/denrasputin/poznanie/actions/workflows/collect.yml/dispatches`
3. **Execution schedule:** *Every hour*, минута `17`.
4. Вкладка **Advanced**:
   - **Request method:** `POST`
   - **Headers:**
     - `Authorization` → `Bearer github_pat_…` (ваш ключ)
     - `Accept` → `application/vnd.github+json`
     - `X-GitHub-Api-Version` → `2022-11-28`
   - **Request body:** `{"ref":"main"}`
5. Сохраните и нажмите **Test run**. Правильный ответ — **204** (принято). Через минуту во вкладке Actions репозитория
   появится запуск «Сбор постов», а после него — «Публикация сайта».

## 3. Что дальше

- Встроенное расписание в `collect.yml` можно оставить запасным: два запуска одновременно не пойдут, второй дождётся очереди.
  Если хотите меньше лишних запусков — замените `"17 * * * *"` на `"47 */3 * * *"` (раз в три часа).
- Ответ **401** — ключ истёк или скопирован с ошибкой: создайте новый и замените в заголовке.
- cron-job.org сам пришлёт письмо, если запросы начнут падать.
