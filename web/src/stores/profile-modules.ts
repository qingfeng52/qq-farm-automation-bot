import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export const useProfileModulesStore = defineStore('profile-modules', () => {
  const data = ref<any>(null)
  const solarTerms = ref<any>(null)
  const activities = ref<any>(null)
  const loading = ref(false)
  const actionLoading = ref(false)
  const error = ref('')

  async function fetchModules(accountId: string) {
    if (!accountId)
      return

    loading.value = true
    error.value = ''
    try {
      const res = await api.get('/api/profile/modules', {
        headers: { 'x-account-id': accountId },
      })
      if (res.data?.ok) {
        data.value = res.data.data || null
      }
      else {
        data.value = null
        error.value = res.data?.error || '加载失败'
      }
    }
    catch (e: any) {
      data.value = null
      error.value = e?.response?.data?.error || e?.message || '加载失败'
    }
    finally {
      loading.value = false
    }
  }

  async function fetchSolarTerms(accountId: string) {
    if (!accountId)
      return
    const res = await api.get('/api/solar-terms', {
      headers: { 'x-account-id': accountId },
    })
    if (!res.data?.ok)
      throw new Error(res.data?.error || '加载节气礼包失败')
    solarTerms.value = res.data.data || null
    return solarTerms.value
  }

  async function claimSolarTerms(accountId: string, solarTermId?: number) {
    if (!accountId)
      return
    actionLoading.value = true
    try {
      const res = await api.post('/api/solar-terms/claim', { solarTermId }, {
        headers: { 'x-account-id': accountId },
      })
      if (!res.data?.ok)
        throw new Error(res.data?.error || '领取节气礼包失败')
      await fetchSolarTerms(accountId)
      return res.data.data
    }
    finally {
      actionLoading.value = false
    }
  }

  async function addDogFood(accountId: string, foodId: number, count = 1) {
    if (!accountId)
      return
    actionLoading.value = true
    try {
      const res = await api.post('/api/profile/dog-food', { foodId, count }, {
        headers: { 'x-account-id': accountId },
      })
      if (!res.data?.ok)
        throw new Error(res.data?.error || '喂狗粮失败')
      await fetchModules(accountId)
      return res.data.data
    }
    finally {
      actionLoading.value = false
    }
  }

  async function fetchActivities(accountId: string) {
    if (!accountId)
      return
    const res = await api.get('/api/activity/modules', {
      headers: { 'x-account-id': accountId },
    })
    if (!res.data?.ok)
      throw new Error(res.data?.error || '加载活动模块失败')
    activities.value = res.data.data || null
    return activities.value
  }

  function clear() {
    data.value = null
    solarTerms.value = null
    activities.value = null
    error.value = ''
  }

  return {
    data,
    solarTerms,
    activities,
    loading,
    actionLoading,
    error,
    fetchModules,
    fetchSolarTerms,
    claimSolarTerms,
    addDogFood,
    fetchActivities,
    clear,
  }
})
